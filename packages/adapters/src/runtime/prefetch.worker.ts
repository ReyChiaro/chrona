import { WorldContent } from "../../../world/src/content";
import type { WorldConfig } from "../../../protocol/src/config";

let config: WorldConfig;
let content: WorldContent;
let generation = 0;

self.onmessage = ({ data }) => {
  try {
    if (data.type === "init") {
      config = data.config;
      content = new WorldContent(data.content);
      generation = data.generation;
    } else if (data.type === "prepare" && data.generation === generation) {
      const chunk = content.generate(data.cell, config, data.record);
      // The prepared copy belongs to the host after transfer; no mesh buffers are copied.
      self.postMessage({ type: "prepared", chunk, generation }, {
        transfer: [chunk.positions.buffer, chunk.colors.buffer, chunk.indices.buffer],
      });
    }
  } catch (error) {
    self.postMessage({ type: "error", generation, message: (error as Error).message });
  }
};
