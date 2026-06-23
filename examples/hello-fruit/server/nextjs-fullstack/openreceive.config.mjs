import {
  createHelloFruitOpenReceive
} from "./src/server/openreceive.ts";

const openreceive = await createHelloFruitOpenReceive();

export { openreceive };
export default openreceive;
