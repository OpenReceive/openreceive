// @openreceive/angular — thin wrapper over the OpenReceive checkout custom
// element. All binding logic lives in @openreceive/elements/wrapper-shared
// (shared with the other element wrappers); this package re-exports that
// surface unchanged. The binding contract is canonical across frameworks:
// { tagName, attributes, listeners }.
export * from "@openreceive/elements/wrapper-shared";
