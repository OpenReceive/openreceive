(() => {
  const settings = window.wc.wcSettings.getSetting("openreceive_data", {});
  const title = window.wp.htmlEntities.decodeEntities(
    settings.title || "Bitcoin Lightning (OpenReceive)",
  );
  const content = window.wp.element.createElement(
    "p",
    null,
    window.wp.htmlEntities.decodeEntities(settings.description || ""),
  );
  window.wc.wcBlocksRegistry.registerPaymentMethod({
    name: "openreceive",
    label: title,
    content,
    edit: content,
    canMakePayment: () => true,
    ariaLabel: title,
    supports: { features: settings.supports || ["products"] },
  });
})();
