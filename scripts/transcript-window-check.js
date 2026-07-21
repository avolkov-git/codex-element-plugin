const assert = require("node:assert/strict");
const {
  StateStore,
  TRANSCRIPT_INITIAL_WINDOW_SIZE,
  TRANSCRIPT_PAGE_SIZE
} = require("../dist/stateStore");

const state = new StateStore();
const chat = state.createChat("project", "Transcript window fixture");
const itemIds = [`${chat.id}-system`];

for (let index = 0; index < 1000; index += 1) {
  const item = state.addTranscriptItem(chat.id, index % 2 === 0 ? "user" : "assistant", `Message ${index}`);
  assert.ok(item);
  itemIds.push(item.id);
}

const tail = state.getTranscriptTail(chat.id);
assert.equal(tail.items.length, TRANSCRIPT_INITIAL_WINDOW_SIZE);
assert.equal(tail.offset, itemIds.length - TRANSCRIPT_INITIAL_WINDOW_SIZE);
assert.deepEqual(tail.items.map((item) => item.id), itemIds.slice(-TRANSCRIPT_INITIAL_WINDOW_SIZE));

let current = tail;
const visited = [...current.items.map((item) => item.id)];
while (current.hasBefore) {
  const previous = state.getTranscriptBefore(chat.id, current.firstItemId, undefined, current.offset);
  assert.ok(previous.items.length <= TRANSCRIPT_PAGE_SIZE, "Previous page must respect the configured page size");
  assert.equal(previous.offset + previous.items.length, current.offset, "Previous page must end at the current boundary");
  visited.unshift(...previous.items.map((item) => item.id));
  current = previous;
}
assert.deepEqual(visited, itemIds, "Backward pagination must visit every transcript item exactly once");

const staleBefore = state.getTranscriptBefore(chat.id, "missing-boundary", undefined, 500);
assert.equal(staleBefore.offset, 500 - TRANSCRIPT_PAGE_SIZE);
assert.deepEqual(staleBefore.items.map((item) => item.id), itemIds.slice(500 - TRANSCRIPT_PAGE_SIZE, 500));

const staleAfter = state.getTranscriptAfter(chat.id, "missing-boundary", undefined, 499);
assert.equal(staleAfter.offset, 500);
assert.deepEqual(staleAfter.items.map((item) => item.id), itemIds.slice(500, 500 + TRANSCRIPT_PAGE_SIZE));

const unknownBoundary = state.getTranscriptBefore(chat.id, "missing-boundary");
assert.equal(unknownBoundary.items.length, 0, "Unknown boundaries must not silently return the transcript tail");

process.stdout.write("Transcript window checks passed.\n");
