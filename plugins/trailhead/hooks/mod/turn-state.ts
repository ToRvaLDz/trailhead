// Whether a main-loop turn is running, shared by the band (register.tsx) and the map pane, which each
// need it and may not hook the same event twice with the same matcher. Module state: a hot reload
// resets it to idle, which only costs a held press being released early.
let isRunning = false

export const markTurnStart = (): void => {
  isRunning = true
}

export const markTurnComplete = (): void => {
  isRunning = false
}

export const isMainTurnRunning = (): boolean => isRunning
