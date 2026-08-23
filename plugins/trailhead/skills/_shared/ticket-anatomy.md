## The Tickets

Each ticket is a child issue. Its **title carries the type icon** (see below); the body stays lean, one Question, sized to one ~100K-token session:

```markdown
Title: 🐛 <clear, specific title>

**Parent:** [<map name>](link)
<!-- map tickets only; a trailhead:whiteboard ticket omits the Parent line entirely -->

## Question
<the decision, investigation, or build goal this ticket resolves>

## Blocked by
<!-- names+links of tickets that must close first; empty → write "nothing (on the frontier)" -->
```

The answer isn't in the body: it's recorded on resolution as a comment. Assets created while resolving a ticket are linked from the issue, not pasted in.

**Visual style.** Tasteful icons for scannability, never at the cost of the lean body. The **type icon** prefixes the ticket title and appears wherever tickets are listed (`/trailhead:map`, inbox):

| Type | Icon | | Map section | Icon |
|---|---|---|---|---|
| `decision` | 🧭 | | Destination | 🎯 |
| `research` | 🔬 | | Notes | 🗒️ |
| `prototype` | 🎨 | | Decisions so far | ✅ |
| `build` | 🔨 | | Not yet specified | 🌫️ |
| `bug` | 🐛 | | Out of scope | 🚫 |
| `task` | 🔧 | | | |

The map issue title is prefixed 🗺, and the three repo anchors carry their own title prefix too, so they stand apart at a glance in the pinned list and in search: **codebase 🧱, conventions 📜, dashboard 📊**. Keep the icons stable and don't add others: they're anchors, not decoration.

