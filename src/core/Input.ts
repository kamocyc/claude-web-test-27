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
  /** Where the pointer went down, consumed once. Null when nothing new. */
  pressNdc: { x: number; y: number } | null = null
  /** Where the pointer is now, in normalised device coordinates. */
  readonly pointerNdc = { x: 0, y: 0 }
  /** True while a pointer is held down. */
  pointerDown = false
  /**
   * Set while the pointer is doing something other than orbiting — dragging a
   * float about. The camera then leaves the gesture alone.
   */
  suppressDrag = false

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

    const toNdc = (event: PointerEvent) => ({
      x: (event.clientX / window.innerWidth) * 2 - 1,
      y: -(event.clientY / window.innerHeight) * 2 + 1,
    })

    const onPointerDown = (event: PointerEvent) => {
      this.dragging = true
      this.pointerDown = true
      this.movedWhileDragging = 0
      this.lastX = event.clientX
      this.lastY = event.clientY
      const ndc = toNdc(event)
      this.pressNdc = ndc
      this.pointerNdc.x = ndc.x
      this.pointerNdc.y = ndc.y
      this.element.setPointerCapture(event.pointerId)
    }
    const onPointerMove = (event: PointerEvent) => {
      const ndc = toNdc(event)
      this.pointerNdc.x = ndc.x
      this.pointerNdc.y = ndc.y
      if (!this.dragging) return
      const dx = event.clientX - this.lastX
      const dy = event.clientY - this.lastY
      this.lastX = event.clientX
      this.lastY = event.clientY
      this.movedWhileDragging += Math.abs(dx) + Math.abs(dy)
      if (this.suppressDrag) return
      this.dragYaw -= dx * 0.0055
      this.dragPitch -= dy * 0.0042
    }
    const onPointerUp = (event: PointerEvent) => {
      this.pointerDown = false
      if (!this.dragging) return
      const wasDragging = this.suppressDrag
      this.dragging = false
      this.suppressDrag = false
      this.element.releasePointerCapture?.(event.pointerId)
      // A drag orbits the camera; a tap splashes the water. Neither, if the
      // gesture was spent hauling a swim ring around.
      if (this.movedWhileDragging < 6 && !wasDragging) {
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

  consumePress(): { x: number; y: number } | null {
    const press = this.pressNdc
    this.pressNdc = null
    return press
  }

  dispose(): void {
    for (const remove of this.detach) remove()
    this.held.clear()
  }
}
