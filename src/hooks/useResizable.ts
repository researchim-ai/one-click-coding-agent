import { useState, useCallback, useRef, useEffect } from 'react'

interface UseResizableOptions {
  direction: 'left' | 'right'
  initialSize: number
  minSize: number
  maxSize: number
  collapsedSize?: number
  collapseThreshold?: number
}

export function useResizable({
  direction,
  initialSize,
  minSize,
  maxSize,
  collapsedSize = 0,
  collapseThreshold = 0,
}: UseResizableOptions) {
  const [size, setSize] = useState(initialSize)
  const [collapsed, setCollapsed] = useState(false)
  const dragging = useRef(false)
  const startX = useRef(0)
  const startSize = useRef(0)

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      dragging.current = true
      startX.current = e.clientX
      startSize.current = collapsed ? minSize : size
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
    },
    [size, collapsed, minSize],
  )

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!dragging.current) return
      const delta = direction === 'left'
        ? e.clientX - startX.current
        : startX.current - e.clientX
      const next = startSize.current + delta

      if (collapseThreshold > 0 && next < collapseThreshold) {
        setCollapsed(true)
        setSize(minSize)
      } else {
        setCollapsed(false)
        setSize(Math.max(minSize, Math.min(maxSize, next)))
      }
    }

    const onMouseUp = () => {
      if (!dragging.current) return
      dragging.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [direction, minSize, maxSize, collapseThreshold])

  const effectiveSize = collapsed ? collapsedSize : size

  return { size: effectiveSize, collapsed, setCollapsed, onMouseDown }
}
