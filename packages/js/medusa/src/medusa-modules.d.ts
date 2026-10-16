// The small part of Medusa this package touches, declared here so the
// monorepo builds without installing Medusa. At runtime these modules are
// the Medusa application's own (peer dependencies), never a bundled copy.

declare module "@medusajs/framework/utils" {
  export abstract class AbstractPaymentProvider<TConfig = Record<string, unknown>> {
    protected readonly config: TConfig;
    protected readonly container: Record<string, unknown>;
    protected constructor(cradle: Record<string, unknown>, config?: TConfig);
    static identifier: string;
    getIdentifier(): string;
  }
  export function ModuleProvider(
    module: string,
    definition: { readonly services: readonly unknown[] },
  ): unknown;
  export const Modules: { readonly PAYMENT: string };
}

declare module "@medusajs/medusa/core-flows" {
  export const processPaymentWorkflow: (container: unknown) => {
    run(options: {
      readonly input: {
        readonly action: string;
        readonly data: { readonly session_id: string; readonly amount: unknown };
      };
    }): Promise<unknown>;
  };
  export const updateRegionsWorkflow: (container: unknown) => {
    run(options: {
      readonly input: {
        readonly selector: { readonly id: unknown };
        readonly update: { readonly payment_providers: readonly string[] };
      };
    }): Promise<unknown>;
  };
}
