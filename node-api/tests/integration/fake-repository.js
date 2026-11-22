// A stand-in for a service's repository: transaction() runs the work with a "q" that records every call
// (name and arguments) and answers from the values given. Any method without a given answer resolves to
// undefined, like a write.
function fakeRepository(answers = {}) {
  const calls = [];
  const afterCommit = [];
  const q = new Proxy({}, {
    get(target, name) {
      if (name === 'afterCommit') return { push: task => afterCommit.push(task) };
      if (name === 'then') return undefined;
      return async (...args) => {
        calls.push([name, ...args]);
        const answer = answers[name];
        return typeof answer === 'function' ? answer(...args) : answer;
      };
    },
  });
  return {
    q, calls, afterCommit,
    repository: { transaction: work => work(q) },
    // Only the calls with these names, as [name, ...args].
    named: (...names) => calls.filter(([name]) => names.includes(name)),
    names: () => calls.map(([name]) => name),
  };
}

// The options object loadOptions() returns.
const optionsWith = (values = {}, dbTime = 7200 * 1000) => ({ get: name => values[name] ?? '', dbTime, isStored: name => name in values });

// Expects the promise to fail with an ApiError of this status and code (and fields, when given).
async function rejectsWith(promise, status, code, fields) {
  let error;
  try { await promise; } catch (caught) { error = caught; }
  if (!error) throw new Error(`expected ${status} ${code}, but it succeeded`);
  expect({ status: error.status, code: error.code }).toEqual({ status, code });
  if (fields !== undefined) expect(error.fields).toEqual(fields);
  return error;
}

module.exports = { fakeRepository, optionsWith, rejectsWith };
