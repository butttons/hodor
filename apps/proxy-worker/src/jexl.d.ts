// Minimal ambient types for `jexl` (TomFrost 2.x). The package ships no types.
declare module "jexl" {
  export class Jexl {
    addFunction(name: string, fn: (...args: unknown[]) => unknown): void;
    addTransform(name: string, fn: (...args: unknown[]) => unknown): void;
    evalSync(expr: string, context?: unknown): unknown;
    eval(expr?: string, context?: unknown): Promise<unknown>;
    compile(expr: string, context?: unknown): unknown;
  }

  const jexl: {
    Jexl: typeof Jexl;
    addFunction(name: string, fn: (...args: unknown[]) => unknown): void;
    addTransform(name: string, fn: (...args: unknown[]) => unknown): void;
    evalSync(expr: string, context?: unknown): unknown;
    eval(expr?: string, context?: unknown): Promise<unknown>;
    compile(expr: string, context?: unknown): unknown;
  };
  export default jexl;
}
