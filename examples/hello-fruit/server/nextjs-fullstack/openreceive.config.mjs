import {
  createHelloFruitOpenReceiveOptions
} from "./src/server/openreceive.ts";

const openreceive = await createHelloFruitOpenReceiveOptions();

export { openreceive };
export default openreceive;
