/**
 * Keyboard and pointer state.
 *
 * Reads as a snapshot the simulation can poll each step rather than a stream of
 * events, which keeps input independent of frame rate.
 */
export class Input {
  private readonly held = new Set<string>()
  /** Accumulated orbit drag since the last read, in radians. */
  dragYaw = 0
  dragPitch = 0
  /** Accumulated wheel zoom since the last read. */
  zoomDelta = 0
  /** Normalised device coordinates of the last click on the water, or null. */
  clickNdc: { x: number; y: number } | null = null

  private dragging = false
  private lastX = 0
  private lastY = 0
  private movedWhileDragging = 0
  private readonly detach: (() => void)[] = []

  constructor(private readonly element: HTMLElement) {
    this.bind()
  }

  private bind(): void {
    const onKeyDown = (event: KeyboardEvent) => {
      this.held.add(event.code)
      // Space scrolls the page otherwise, which fights with diving.
      if (event.code === 'Space') event.preventDefault()
    }
    const onKeyUp = (event: KeyboardEvent) => this.held.delete(event.code)
    const onBlur = () => this.held.clear()

    const onPointerDown = (event: PointerEvent) => {
      this.dragging = true
      this.movedWhileDragging = 0
      this.lastX = event.clientX
      this.lastY = event.clientY
      this.element.setPointerCapture(event.pointerId)
    }
    const onPointerMove = (event: PointerEvent) => {
      if (!this.dragging) return
      const dx = event.clientX - this.lastX
      const dy = event.clientY - this.lastY
      this.lastX = event.clientX
      this.lastY = event.clientY
      this.movedWhileDragging += Math.abs(dx) + Math.abs(dy)
      this.dragYaw -= dx * 0.0055
      this.dragPitch -= dy * 0.0042
    }
    const onPointerUp = (event: PointerEvent) => {
      if (!this.dragging) return
      this.dragging = false
      this.element.releasePointerCapture?.(event.pointerId)
      // A drag orbits the camera; a tap splashes the water.
      if (this.movedWhileDragging < 6) {
        this.clickNdc = {
          x: (event.clientX / window.innerWidth) * 2 - 1,
          y: -(event.clientY / window.innerHeight) * 2 + 1,
        }
      }
    }
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      this.zoomDelta += Math.sign(event.deltaY) * 0.6
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    this.element.addEventListener('pointerdown', onPointerDown)
    this.element.addEventListener('pointermove', onPointerMove)
    this.element.addEventListener('pointerup', onPointerUp)
    this.element.addEventListener('pointercancel', onPointerUp)
    this.element.addEventListener('wheel', onWheel, { passive: false })

    this.detach.push(
      () => window.removeEventListener('keydown', onKeyDown),
      () => window.removeEventListener('keyup', onKeyUp),
      () => window.removeEventListener('blur', onBlur),
      () => this.element.removeEventListener('pointerdown', onPointerDown),
      () => this.element.removeEventListener('pointermove', onPointerMove),
      () => this.element.removeEventListener('pointerup', onPointerUp),
      () => this.element.removeEventListener('pointercancel', onPointerUp),
      () => this.element.removeEventListener('wheel', onWheel),
    )
  }

  isDown(...codes: string[]): boolean {
    for (const code of codes) if (this.held.has(code)) return true
    return false
  }

  /** Movement intent in camera space: x is strafe, y is forward. */
  moveAxis(out: { x: number; y: number }): void {
    out.x = (this.isDown('KeyD', 'ArrowRight') ? 1 : 0) - (this.isDown('KeyA', 'ArrowLeft') ? 1 : 0)
    out.y = (this.isDown('KeyW', 'ArrowUp') ? 1 : 0) - (this.isDown('KeyS', 'ArrowDown') ? 1 : 0)
  }

  consumeDrag(out: { yaw: number; pitch: number; zoom: number }): void {
    out.yaw = this.dragYaw
    out.pitch = this.dragPitch
    out.zoom = this.zoomDelta
    this.dragYaw = 0
    this.dragPitch = 0
    this.zoomDelta = 0
  }

  consumeClick(): { x: number; y: number } | null {
    const click = this.clickNdc
    this.clickNdc = null
    return click
  }

  dispose(): void {
    for (const remove of this.detach) remove()
    this.held.clear()
  }
}
