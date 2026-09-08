import { Camera } from '../render/camera';

/** Movement beyond this many CSS pixels turns a press into a drag, not a tap. */
const TAP_SLOP = 8;
const WHEEL_ZOOM_RATE = 0.0016;

export interface InputHandlers {
  onTap(screenX: number, screenY: number): void;
  onHover(screenX: number, screenY: number): void;
  onHoverEnd(): void;
  onTogglePause(): void;
  onSetSpeed(index: number): void;
  onCancel(): void;
}

interface Pointer {
  x: number;
  y: number;
  startX: number;
  startY: number;
  dragging: boolean;
}

/**
 * Pan, zoom and selection from Pointer Events, so mouse, trackpad, pen and
 * touch all take the same path. One pointer pans or taps; two pinch-zoom.
 */
export class InputController {
  private readonly pointers = new Map<number, Pointer>();
  private pinchDistance = 0;
  private pinchCenter: [number, number] = [0, 0];
  private disposers: (() => void)[] = [];

  /**
   * The camera is read through a getter rather than captured: starting a new
   * world replaces the Camera instance, and holding a direct reference would
   * leave every gesture driving the discarded one.
   */
  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly getCamera: () => Camera,
    private readonly handlers: InputHandlers,
  ) {
    this.attach();
  }

  private get camera(): Camera {
    return this.getCamera();
  }

  dispose(): void {
    for (const dispose of this.disposers) dispose();
    this.disposers = [];
  }

  private on<K extends keyof HTMLElementEventMap>(
    target: HTMLElement | Window,
    type: K,
    listener: (event: HTMLElementEventMap[K]) => void,
    options?: AddEventListenerOptions,
  ): void {
    const handler = listener as EventListener;
    target.addEventListener(type, handler, options);
    this.disposers.push(() => target.removeEventListener(type, handler, options));
  }

  private localPoint(event: PointerEvent | WheelEvent): [number, number] {
    const rect = this.canvas.getBoundingClientRect();
    return [event.clientX - rect.left, event.clientY - rect.top];
  }

  private get view(): { width: number; height: number } {
    const rect = this.canvas.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  }

  private attach(): void {
    this.on(this.canvas, 'pointerdown', (event) => {
      const [x, y] = this.localPoint(event);
      this.canvas.setPointerCapture(event.pointerId);
      this.pointers.set(event.pointerId, { x, y, startX: x, startY: y, dragging: false });

      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        this.pinchDistance = Math.hypot(a.x - b.x, a.y - b.y);
        this.pinchCenter = [(a.x + b.x) / 2, (a.y + b.y) / 2];
        // A second finger means this is a pinch, never a tap.
        for (const pointer of this.pointers.values()) pointer.dragging = true;
      }
    });

    this.on(this.canvas, 'pointermove', (event) => {
      const [x, y] = this.localPoint(event);
      const pointer = this.pointers.get(event.pointerId);

      if (!pointer) {
        if (event.pointerType === 'mouse') this.handlers.onHover(x, y);
        return;
      }

      const previous = { x: pointer.x, y: pointer.y };
      pointer.x = x;
      pointer.y = y;

      if (this.pointers.size >= 2) {
        this.updatePinch();
        return;
      }

      if (!pointer.dragging) {
        const moved = Math.hypot(x - pointer.startX, y - pointer.startY);
        if (moved <= TAP_SLOP) return;
        pointer.dragging = true;
      }

      this.camera.panBy(x - previous.x, y - previous.y, this.view);
    });

    const release = (event: PointerEvent): void => {
      const pointer = this.pointers.get(event.pointerId);
      if (!pointer) return;
      this.pointers.delete(event.pointerId);
      if (this.canvas.hasPointerCapture(event.pointerId)) {
        this.canvas.releasePointerCapture(event.pointerId);
      }

      if (!pointer.dragging && event.type === 'pointerup') {
        this.handlers.onTap(pointer.x, pointer.y);
      }

      // Re-anchor the pinch when going from two fingers back to one, so the
      // remaining finger does not teleport the map.
      if (this.pointers.size === 1) {
        const remaining = [...this.pointers.values()][0];
        remaining.dragging = true;
        remaining.startX = remaining.x;
        remaining.startY = remaining.y;
      }
    };

    this.on(this.canvas, 'pointerup', release);
    this.on(this.canvas, 'pointercancel', release);
    this.on(this.canvas, 'pointerleave', (event) => {
      if (event.pointerType === 'mouse') this.handlers.onHoverEnd();
    });

    this.on(
      this.canvas,
      'wheel',
      (event) => {
        event.preventDefault();
        const [x, y] = this.localPoint(event);
        // Trackpad pinch arrives as a ctrl-modified wheel event.
        const intensity = event.ctrlKey ? 3 : 1;
        const factor = Math.exp(-event.deltaY * WHEEL_ZOOM_RATE * intensity);
        this.camera.zoomAt(factor, x, y, this.view);
      },
      { passive: false },
    );

    // Suppress the long-press context menu, which otherwise interrupts panning.
    this.on(this.canvas, 'contextmenu', (event) => event.preventDefault());

    this.on(window, 'keydown', (event) => {
      if (event.target instanceof HTMLInputElement) return;

      switch (event.key) {
        case ' ':
          event.preventDefault();
          this.handlers.onTogglePause();
          return;
        case 'Escape':
          this.handlers.onCancel();
          return;
        case '1':
        case '2':
        case '3':
          this.handlers.onSetSpeed(Number(event.key) - 1);
          return;
        default:
          break;
      }

      const view = this.view;
      const pan = 90 / this.camera.zoom;
      switch (event.key) {
        case 'ArrowLeft':
        case 'a':
          this.camera.panBy(pan * this.camera.zoom, 0, view);
          break;
        case 'ArrowRight':
        case 'd':
          this.camera.panBy(-pan * this.camera.zoom, 0, view);
          break;
        case 'ArrowUp':
        case 'w':
          this.camera.panBy(0, pan * this.camera.zoom, view);
          break;
        case 'ArrowDown':
        case 's':
          this.camera.panBy(0, -pan * this.camera.zoom, view);
          break;
        case '+':
        case '=':
          this.camera.zoomAt(1.2, view.width / 2, view.height / 2, view);
          break;
        case '-':
        case '_':
          this.camera.zoomAt(1 / 1.2, view.width / 2, view.height / 2, view);
          break;
        default:
          break;
      }
    });
  }

  private updatePinch(): void {
    const [a, b] = [...this.pointers.values()];
    if (!a || !b) return;

    const distance = Math.hypot(a.x - b.x, a.y - b.y);
    const center: [number, number] = [(a.x + b.x) / 2, (a.y + b.y) / 2];
    const view = this.view;

    if (this.pinchDistance > 0 && distance > 0) {
      this.camera.zoomAt(distance / this.pinchDistance, center[0], center[1], view);
    }
    // Two-finger drag pans as well as zooms.
    this.camera.panBy(center[0] - this.pinchCenter[0], center[1] - this.pinchCenter[1], view);

    this.pinchDistance = distance;
    this.pinchCenter = center;
  }
}
