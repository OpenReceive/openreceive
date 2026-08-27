// Shakapacker deep-merges this into its default swc-loader options. TypeScript
// legacy decorators are required for mobx-keystone's @model / @modelAction /
// @modelFlow, and keepClassNames keeps model names stable for its registry.
//
// tsconfig.json's `experimentalDecorators: true` and
// `useDefineForClassFields: false` are the other half of the same setting, and
// both are LOAD-BEARING. With the ES default for class fields, a decorated
// class property is DEFINED rather than assigned, the decorator never applies,
// and every arrow-form @modelAction — `setTab = (tab) => …`, the form that
// binds `this` so a component can pass it straight to onClick — silently stops
// being an action. At runtime, with no type error.
module.exports = {
  options: {
    jsc: {
      parser: {
        decorators: true,
      },
      transform: {
        legacyDecorator: true,
        decoratorMetadata: true,
        react: {
          runtime: "automatic",
        },
      },
      keepClassNames: true,
    },
  },
};
