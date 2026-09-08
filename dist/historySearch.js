"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.searchHistory = searchHistory;
async function searchHistory(history, queryValue, offsetValue = 0) {
    const query = typeof queryValue === "string" ? queryValue.trim().slice(0, 200).toLocaleLowerCase() : "";
    const offset = typeof offsetValue === "number" && Number.isInteger(offsetValue) ? Math.max(0, Math.min(10000, offsetValue)) : 0;
    const items = [];
    if (!query) {
        return { items, nextOffset: null };
    }
    let matches = 0, inspected = 0;
    for (const chat of history.chats) {
        for (const item of history.transcripts[chat.id] ?? []) {
            if (++inspected % 500 === 0) {
                await new Promise((resolve) => setImmediate(resolve));
            }
            if (item.kind !== "message") {
                continue;
            }
            const position = item.text.toLocaleLowerCase().indexOf(query);
            if (position < 0 && !chat.title.toLocaleLowerCase().includes(query)) {
                continue;
            }
            if (matches++ < offset) {
                continue;
            }
            if (items.length === 50) {
                return { items, nextOffset: offset + items.length };
            }
            const start = Math.max(0, position - 60);
            items.push({ chatId: chat.id, itemId: item.id, title: chat.title, excerpt: `${start ? "…" : ""}${item.text.slice(start, start + 240)}`, createdAt: item.createdAt });
        }
    }
    return { items, nextOffset: null };
}
//# sourceMappingURL=historySearch.js.map