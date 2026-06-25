import {
  createHelloFruitOpenReceive
} from "./src/server/create-server.ts";

const { openreceive } = await createHelloFruitOpenReceive();

export { openreceive };
export default openreceive;
