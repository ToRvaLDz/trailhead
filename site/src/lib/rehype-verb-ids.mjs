// Rehype plugin (#196): gives each `### /trailhead:<verb>` heading the stable
// id `<verb>`, so the verb guides keep short, predictable anchors
// (`/docs/commands/work#quick`) while the headings stay real markdown
// headings that Starlight lists in "On this page".

const VERB_HEADING = /^\/trailhead:([a-z][a-z-]*)$/;

function textOf(node) {
  if (node.type === 'text') return node.value;
  return (node.children ?? []).map(textOf).join('');
}

function visit(node) {
  if (node.type === 'element' && node.tagName === 'h3') {
    const match = textOf(node).trim().match(VERB_HEADING);
    if (match) {
      node.properties = { ...node.properties, id: match[1] };
    }
  }
  (node.children ?? []).forEach(visit);
}

export default function rehypeVerbIds() {
  return (tree) => visit(tree);
}
