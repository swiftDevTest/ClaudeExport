export function compareElementsInDocument(left, right) {
  if (left === right) return 0;
  if (!left || !right || typeof left.compareDocumentPosition !== "function") return 0;
  var position = left.compareDocumentPosition(right);
  if (position & 1) return 0; // Disconnected nodes have no shared document order.
  if (position & 2) return 1; // DOCUMENT_POSITION_PRECEDING
  if (position & 4) return -1; // DOCUMENT_POSITION_FOLLOWING
  return 0;
}

// Keep the first matching candidate (selector priority), without comparing
// every message with every other message. Ancestor walks scale with DOM depth.
export function selectDistinctDocumentElements(elements) {
  var selected = new Set();
  var selectedAncestors = new Set();
  Array.prototype.forEach.call(elements || [], function (element) {
    if (!element || selected.has(element) || selectedAncestors.has(element)) return;
    var ancestors = [];
    for (var parent = element.parentNode; parent; parent = parent.parentNode) {
      if (selected.has(parent)) return;
      ancestors.push(parent);
    }
    selected.add(element);
    ancestors.forEach(function (ancestor) { selectedAncestors.add(ancestor); });
  });
  return Array.from(selected).sort(compareElementsInDocument);
}

export function pushDistinctDocumentElement(list, element) {
  if (!element) return;
  for (var index = list.length - 1; index >= 0; index -= 1) {
    var existing = list[index];
    if (existing === element || existing.contains && existing.contains(element)) {
      return;
    }
    if (element.contains && element.contains(existing)) {
      list.splice(index, 1);
    }
  }
  list.push(element);
}

export function collapseNestedDocumentElements(elements, maxElements = Infinity) {
  var unique = Array.from(new Set((elements || []).filter(Boolean)));
  unique.sort(compareElementsInDocument);
  return selectDistinctDocumentElements(unique).slice(0, Math.max(1, maxElements));
}
