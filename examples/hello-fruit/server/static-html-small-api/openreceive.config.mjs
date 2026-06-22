import {
  createHelloFruitOpenReceiveOptions
} from "./src/server/create-server.ts";

const openreceive = await createHelloFruitOpenReceiveOptions();

export { openreceive };
export default openreceive;
