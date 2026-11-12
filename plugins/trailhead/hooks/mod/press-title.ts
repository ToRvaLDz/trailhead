// The title of the ticket the panel last pressed, handed to the session title of the prompt it sends
// (the engine writes the ticket's state only later in that turn). Module state: a /clear keeps it.
let pressed: { ticket: number; title: string } | null = null

export const notePressTitle = (ticket: number, title: string): void => {
  pressed = { ticket, title }
}

export const pressTitleOf = (ticket: number): string | null => (pressed !== null && pressed.ticket === ticket ? pressed.title : null)
