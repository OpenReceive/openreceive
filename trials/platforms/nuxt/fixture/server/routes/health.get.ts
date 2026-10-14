// Answers once the shop's tables exist.
export default defineEventHandler(async (event) => {
  await useShopDb();
  setResponseHeader(event, "content-type", "text/plain");
  return "ok\n";
});
