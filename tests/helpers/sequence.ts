export type SequenceBody = (step: SequenceStep) => void | Promise<void>;
export type SequenceStep = (name: string, body: SequenceBody) => Promise<void>;

/** Run ordered fixture cases and report every failure after their cleanup settles. */
export const runSequence = async (body: SequenceBody): Promise<void> => {
  const failures: Error[] = [];
  const createStep =
    (parents: readonly string[]): SequenceStep =>
    async (name, run) => {
      const names = [...parents, name];
      try {
        await run(createStep(names));
      } catch (cause) {
        failures.push(new Error(names.join(" > "), { cause }));
      }
    };
  try {
    await body(createStep([]));
  } catch (cause) {
    failures.push(new Error("Sequence body or cleanup failed", { cause }));
  }
  if (failures.length) throw new AggregateError(failures, "Ordered fixture sequence failed");
};
