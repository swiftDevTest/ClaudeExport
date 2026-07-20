export function compareElementsInDocument(left, right) {
  if (left === right) return 0;
  if (!left || !right || typeof left.compareDocumentPosition !== "function") return 0;
  var position = left.compareDocumentPosition(right);
  if (typeof Node !== "undefined") {
    if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
  }
  return 0;
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

export function collapseNestedDocumentElements(elements, maxElements = 1000) {
  var unique = Array.from(new Set((elements || []).filter(Boolean))).slice(0, Math.max(1, maxElements));
  unique.sort(compareElementsInDocument);
  var collapsed = [];
  unique.forEach(function (element) {
    var previous = collapsed[collapsed.length - 1];
    if (previous && previous !== element && previous.contains && previous.contains(element)) return;
    collapsed.push(element);
  });
  return collapsed;
}
