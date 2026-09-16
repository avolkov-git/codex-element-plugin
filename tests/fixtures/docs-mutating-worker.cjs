const fs = require("node:fs");
const { workerData } = require("node:worker_threads");
const open = fs.createReadStream;
const signal = new Int32Array(workerData.signal);

fs.createReadStream = function(file, ...args) {
  const count = Atomics.load(signal, 0);
  if (String(file) === workerData.file && count < workerData.mutations) {
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replaceAll(count % 2 ? "Bravo" : "Alpha", count % 2 ? "Alpha" : "Bravo"));
    Atomics.add(signal, 0, 1);
  }
  return open.call(this, file, ...args);
};

require(workerData.workerPath);
