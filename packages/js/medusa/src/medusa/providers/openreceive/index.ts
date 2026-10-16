import { ModuleProvider, Modules } from "@medusajs/framework/utils";
import { OpenReceivePaymentProviderService } from "./service.ts";

// Registered in medusa-config under the payment module's providers, as
// `@openreceive/medusa/providers/openreceive` with id "openreceive".
export default ModuleProvider(Modules.PAYMENT, {
  services: [OpenReceivePaymentProviderService],
});
