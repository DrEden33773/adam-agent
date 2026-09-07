const immutableValues = new WeakSet<object>();

// Frozen accessors can still change their results. Only frozen JSON data properties
// grant identity reuse; caller-owned accessors and custom prototypes stay on validation.
export function isDeeplyImmutable(value: unknown): boolean {
  if (value === null || typeof value !== "object") return typeof value !== "function";
  if (immutableValues.has(value)) return true;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null)
    return false;
  if (!Object.isFrozen(value)) return false;
  const descriptors = Object.values(Object.getOwnPropertyDescriptors(value));
  if (
    !descriptors.every((descriptor) => "value" in descriptor && isDeeplyImmutable(descriptor.value))
  )
    return false;
  immutableValues.add(value);
  return true;
}
