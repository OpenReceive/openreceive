// Shakapacker deep-merges this into its default swc-loader options. TypeScript
// legacy decorators are required for mobx-keystone's @model / @modelAction /
// @modelFlow, and keepClassNames keeps model names stable for its registry.
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
