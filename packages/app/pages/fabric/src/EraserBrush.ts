import * as fabric from 'fabric';
import { FabricObject, Group, Path } from 'fabric';
import { erase } from '../../core/src/erase';
import { ClippingGroup } from './ClippingGroup';
import { draw } from './ErasingEffect';

export type EventDetailMap = {
  start: fabric.TEvent<fabric.TPointerEvent>;
  move: fabric.TEvent<fabric.TPointerEvent>;
  end: {
    path: fabric.Path;
    targets: fabric.FabricObject[];
  };
  redraw: { type: 'start' | 'render' };
  cancel: never;
};

export type ErasingEventType = keyof EventDetailMap;

export type ErasingEvent<T extends ErasingEventType> = CustomEvent<
  EventDetailMap[T]
>;

function walk(objects: FabricObject[], path: Path): FabricObject[] {
  return objects.flatMap((object) => {
    if (!object.erasable || !object.intersectsWithObject(path)) { // 检查对象是否与另一个对象相交
      return [];
    } else if (object instanceof Group && object.erasable === 'deep') {
      return walk(object.getObjects(), path);
    } else {
      return [object];
    }
  });
}

const assertClippingGroup = (object: fabric.FabricObject) => {
  const curr = object.clipPath;

  if (curr instanceof ClippingGroup) {
    return curr;
  }

  const next = new ClippingGroup([], {
    width: object.width,
    height: object.height,
  });

  if (curr) {
    const { x, y } = curr.translateToOriginPoint(
      new fabric.Point(),
      curr.originX,
      curr.originY
    );
    curr.originX = curr.originY = 'center';
    fabric.util.sendObjectToPlane(
      curr,
      undefined,
      fabric.util.createTranslateMatrix(x, y)
    );
    next.add(curr as FabricObject);
  }

  return (object.clipPath = next);
};

export function commitErasing(
  object: fabric.FabricObject,
  sourceInObjectPlane: fabric.Path
) {
  const clipPath = assertClippingGroup(object);
  clipPath.add(sourceInObjectPlane);
  clipPath.set('dirty', true);
  object.set('dirty', true);
}

export async function eraseObject(
  object: fabric.FabricObject,
  source: fabric.Path
) {
  const clone = await source.clone();
  fabric.util.sendObjectToPlane(clone, undefined, object.calcTransformMatrix());
  commitErasing(object, clone);
  return clone;
}

export async function eraseCanvasDrawable(
  object: fabric.FabricObject,
  vpt: fabric.TMat2D | undefined,
  source: fabric.Path
) {
  const clone = await source.clone();
  const d =
    vpt &&
    object.translateToOriginPoint(
      new fabric.Point(),
      object.originX,
      object.originY
    );
  fabric.util.sendObjectToPlane(
    clone,
    undefined,
    d
      ? fabric.util.multiplyTransformMatrixArray([
          [1, 0, 0, 1, d.x, d.y],
          // apply vpt from center of drawable
          vpt,
          [1, 0, 0, 1, -d.x, -d.y],
          object.calcTransformMatrix(),
        ])
      : object.calcTransformMatrix()
  );
  commitErasing(object, clone);
  return clone;
}

const setCanvasDimensions = (
  el: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  { width, height }: fabric.TSize,
  retinaScaling = 1
) => {
  el.width = width;
  el.height = height;
  if (retinaScaling > 1) {
    el.setAttribute('width', (width * retinaScaling).toString());
    el.setAttribute('height', (height * retinaScaling).toString());
    ctx.scale(retinaScaling, retinaScaling);
  }
};

/**
 * Supports **selective** erasing: only erasable objects are affected by the eraser brush.
 * 支持选择性擦除:只有可擦除的对象受到擦除刷的影响。
 *
 * Supports **{@link inverted}** erasing: the brush can "undo" erasing.
 * 可以“撤销”擦除
 *
 * Supports **alpha** erasing: setting the alpha channel of the `color` property controls the eraser intensity.
 * 设置' color '属性的alpha通道控制擦除强度
 *
 * In order to support selective erasing, the brush clips the entire canvas and
 * masks all non-erasable objects over the erased path, see {@link draw}.
 * 为了支持选择性擦除，笔刷剪辑整个画布和掩码所有不可擦除的对象在擦除的路径
 *
 * If **{@link inverted}** draws all objects, erasable objects without their eraser, over the erased path.
 * This achieves the desired effect of seeming to erase or undo erasing on erasable objects only.
 * 如果绘制所有对象，可擦除的对象没有擦除器，在擦除的路径上。 这达到了只对可擦除对象进行擦除或撤消擦除的预期效果
 * 
 * After erasing is done the `end` event {@link ErasingEndEvent} is fired, after which erasing will be committed to the tree.
 * @example
 * canvas = new Canvas();
 * const eraser = new EraserBrush(canvas);
 * canvas.freeDrawingBrush = eraser;
 * canvas.isDrawingMode = true;
 * eraser.on('start', (e) => {
 *    console.log('started erasing');
 *    // prevent erasing
 *    e.preventDefault();
 * });
 * eraser.on('end', (e) => {
 *    const { targets: erasedTargets, path } = e.detail;
 *    e.preventDefault(); // prevent erasing being committed to the tree
 *    eraser.commit({ targets: erasedTargets, path }); // commit manually since default was prevented
 * });
 *
 * In case of performance issues trace {@link drawEffect} calls and consider preventing it from executing
 * @example
 * const eraser = new EraserBrush(canvas);
 * eraser.on('redraw', (e) => {
 *    // prevent effect redraw on pointer down (e.g. useful if canvas didn't change)
 *    // 防止指针向下时的重画效果(例如，如果画布没有改变，则有用)
 *    e.detail.type === 'start' && e.preventDefault());
 *    // prevent effect redraw after canvas has rendered (effect will become stale)
 *    // 防止画布渲染后效果重绘(效果会过时)
 *    e.detail.type === 'render' && e.preventDefault());
 * });
 */
export class EraserBrush extends fabric.PencilBrush {
  /**
   * When set to `true` the brush will create a visual effect of undoing erasing
   * 当设置为“true”时，笔刷将创建一个取消擦除的视觉效果
   */
  inverted = false;

  effectContext: CanvasRenderingContext2D;

  private eventEmitter: EventTarget;
  private active = false;
  private _disposer?: VoidFunction;

  constructor(canvas: fabric.Canvas) {
    super(canvas);
    const el = document.createElement('canvas');
    const ctx = el.getContext('2d');
    if (!ctx) {
      throw new Error('Failed to get context');
    }
    setCanvasDimensions(el, ctx, canvas, this.canvas.getRetinaScaling());
    this.effectContext = ctx;
    this.eventEmitter = new EventTarget();
  }

  /**
   * @returns disposer make sure to call it to avoid memory leaks
   */
  on<T extends ErasingEventType>(
    type: T,
    cb: (evt: ErasingEvent<T>) => any,
    options?: boolean | AddEventListenerOptions
  ) {
    this.eventEmitter.addEventListener(type, cb as EventListener, options);
    return () =>
      this.eventEmitter.removeEventListener(type, cb as EventListener, options);
  }

  drawEffect() {
    draw(
      this.effectContext,
      {
        opacity: new fabric.Color(this.color).getAlpha(),
        inverted: this.inverted,
      },
      { canvas: this.canvas }
    );
  }

  /**
   * @override
   */
  _setBrushStyles(ctx: CanvasRenderingContext2D = this.canvas.contextTop) {
    super._setBrushStyles(ctx);
    ctx.strokeStyle = 'black';
  }

  /**
   * @override strictly speaking the eraser needs a full render only if it has opacity set.
   * However since {@link PencilBrush} is designed for subclassing that is what we have to work with.
   */
  needsFullRender(): boolean {
    return true;
  }

  /**
   * @override erase
   */
  _render(ctx: CanvasRenderingContext2D = this.canvas.getTopContext()): void {
    super._render(ctx);
    erase(this.canvas.getContext(), ctx, this.effectContext);
  }

  /**
   * @override {@link drawEffect}
   */
  onMouseDown(
    pointer: fabric.Point,
    context: fabric.TEvent<fabric.TPointerEvent>
  ): void {
    if (
      !this.eventEmitter.dispatchEvent(
        new CustomEvent('start', { detail: context, cancelable: true })
      )
    ) {
      return;
    }

    this.active = true;

    // 当 event 可被取消（cancelable 值为 true），且 event 中至少有一个事件处理程序调用了 Event.preventDefault() 方法时，返回 false。否则，返回 true
    this.eventEmitter.dispatchEvent(
      new CustomEvent('redraw', {
        detail: { type: 'start' },
        cancelable: true,
      })
    ) && this.drawEffect();

    // consider a different approach
    // this._disposer = this.canvas.on('after:render', ({ ctx }) => {
    //   if (ctx !== this.canvas.getContext()) {
    //     return;
    //   }
    //   this.eventEmitter.dispatchEvent(
    //     new CustomEvent('redraw', {
    //       detail: { type: 'render' },
    //       cancelable: true,
    //     })
    //   ) && this.drawEffect();
    //   this._render();
    // });

    super.onMouseDown(pointer, context);
  }

  /**
   * @override run if active
   */
  onMouseMove(
    pointer: fabric.Point,
    context: fabric.TEvent<fabric.TPointerEvent>
  ): void {
    this.active &&
      this.eventEmitter.dispatchEvent(
        new CustomEvent('move', { detail: context, cancelable: true })
      ) &&
      super.onMouseMove(pointer, context);
  }

  /**
   * @override run if active, dispose of {@link drawEffect} listener
   */
  onMouseUp(context: fabric.TEvent<fabric.TPointerEvent>): boolean {
    this.active && super.onMouseUp(context);
    this.active = false;
    // this._disposer?.();
    delete this._disposer;
    return false;
  }

  /**
   * @override {@link fabric.PencilBrush} logic
   */
  convertPointsToSVGPath(points: fabric.Point[]): fabric.util.TSimplePathData {
    return super.convertPointsToSVGPath(
      this.decimate ? this.decimatePoints(points, this.decimate) : points
    );
  }

  /**
   * @override
   */
  createPath(pathData: fabric.util.TSimplePathData) {
    const path = super.createPath(pathData);
    path.set(
      this.inverted
        ? {
            // globalCompositeOperation 在绘制新形状时应用的合成操作的类型
            globalCompositeOperation: 'source-over', // 路径被绘制在已有图形的上方
            stroke: 'white',
          }
        : {
            globalCompositeOperation: 'destination-out', // 已有的图形只保留在已有图形与路径不重叠的地方，重叠部分变透明。
            stroke: 'black',
            opacity: new fabric.Color(this.color).getAlpha(),
          }
    );
    return path;
  }

  async commit({ path, targets }: EventDetailMap['end']) {
    const result = new Map(
      await Promise.all([
        ...targets.map(async (object) => {
          return [object, await eraseObject(object, path)] as const;
        }),
        ...(
          [
            [
              this.canvas.backgroundImage,
              !this.canvas.backgroundVpt
                ? this.canvas.viewportTransform
                : undefined,
            ],
            [
              this.canvas.overlayImage,
              !this.canvas.overlayVpt
                ? this.canvas.viewportTransform
                : undefined,
            ],
          ] as const
        )
          .filter(([object]) => object)
          .map(async ([object, vptFlag]) => {
            return [
              object,
              await eraseCanvasDrawable(object as FabricObject, vptFlag, path),
            ] as const;
          }),
      ])
    );

    console.log('==result==', result)
    return result
  }

  /**
   * @override handle events
   */
  _finalizeAndAddPath(): void {
    const points = this['_points'];

    if (points.length < 2) {
      this.eventEmitter.dispatchEvent(
        new CustomEvent('cancel', {
          cancelable: false,
        })
      );
      return;
    }

    const path = this.createPath(this.convertPointsToSVGPath(points));
    const targets = walk(this.canvas.getObjects(), path);

    console.log('==path', path)

    this.eventEmitter.dispatchEvent(
      new CustomEvent('end', {
        detail: {
          path,
          targets,
        },
        cancelable: true,
      })
    ) && this.commit({ path, targets });

    this.canvas.clearContext(this.canvas.contextTop);
    this.canvas.requestRenderAll();

    this._resetShadow();
  }

  dispose() {
    const { canvas } = this.effectContext;
    // prompt GC
    canvas.width = canvas.height = 0;
    // release ref?
    // delete this.effectContext
  }
}
