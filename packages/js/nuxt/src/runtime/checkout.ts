import options from "#openreceive/options";
import Checkout from "@openreceive/vue/checkout.vue";
import { defineComponent, h } from "vue";

// <OpenReceiveCheckout>: the @openreceive/vue checkout with `prefix` set to
// the module's route, so the page and the route cannot disagree. Every prop,
// event handler and slot passes through; a `prefix` prop still wins.
const OpenReceiveCheckout = defineComponent({
  name: "OpenReceiveCheckout",
  inheritAttrs: false,
  setup(_props, { attrs, slots }) {
    return () => h(Checkout, { prefix: options.prefix, ...attrs }, slots);
  },
}) as unknown as typeof Checkout;

export default OpenReceiveCheckout;
