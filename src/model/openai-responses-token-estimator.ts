type ChatEstimatorToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

type ChatEstimatorMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: unknown;
  tool_calls?: ChatEstimatorToolCall[];
  tool_call_id?: string;
};

export function responsesPayloadForChatTokenEstimator(
  payload: unknown,
): Record<string, unknown> {
  const root = requireRecord(payload, "Responses token estimator payload");
  if (!Array.isArray(root.input)) {
    throw new Error("Responses token estimator payload input must be an array.");
  }

  const messages: ChatEstimatorMessage[] = [];
  for (const [index, rawItem] of root.input.entries()) {
    const path = `Responses token estimator input[${index}]`;
    const item = requireRecord(rawItem, path);
    const type = requireString(item.type, `${path}.type`);
    if (type === "message") {
      messages.push(toChatMessage(item, path));
      continue;
    }
    if (type === "function_call") {
      appendFunctionCall(messages, item, path);
      continue;
    }
    if (type === "function_call_output") {
      messages.push({
        role: "tool",
        tool_call_id: requireString(item.call_id, `${path}.call_id`),
        content: requireString(item.output, `${path}.output`),
      });
      continue;
    }
    throw new Error(`${path}.type is unsupported: ${JSON.stringify(type)}.`);
  }

  return {
    messages,
    ...(root.tools === undefined ? {} : { tools: toChatTools(root.tools) }),
  };
}

function toChatMessage(
  item: Record<string, unknown>,
  path: string,
): ChatEstimatorMessage {
  const role = requireString(item.role, `${path}.role`);
  if (role !== "system" && role !== "user" && role !== "assistant") {
    throw new Error(`${path}.role is unsupported: ${JSON.stringify(role)}.`);
  }
  return {
    role,
    content: toChatContent(item.content, `${path}.content`),
  };
}

function toChatContent(value: unknown, path: string): unknown {
  if (typeof value === "string") {
    return value;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${path} must be a string or an array.`);
  }
  return value.map((rawPart, index) => {
    const partPath = `${path}[${index}]`;
    const part = requireRecord(rawPart, partPath);
    const type = requireString(part.type, `${partPath}.type`);
    if (type === "input_text") {
      return {
        type: "text",
        text: requireString(part.text, `${partPath}.text`),
      };
    }
    if (type === "input_image") {
      return {
        type: "image_url",
        image_url: {
          url: requireString(part.image_url, `${partPath}.image_url`),
          ...(part.detail === undefined
            ? {}
            : { detail: requireString(part.detail, `${partPath}.detail`) }),
        },
      };
    }
    throw new Error(`${partPath}.type is unsupported: ${JSON.stringify(type)}.`);
  });
}

function appendFunctionCall(
  messages: ChatEstimatorMessage[],
  item: Record<string, unknown>,
  path: string,
): void {
  const call: ChatEstimatorToolCall = {
    id: requireString(item.call_id, `${path}.call_id`),
    type: "function",
    function: {
      name: requireString(item.name, `${path}.name`),
      arguments: requireString(item.arguments, `${path}.arguments`),
    },
  };
  const previous = messages[messages.length - 1];
  if (previous?.role === "assistant") {
    (previous.tool_calls ??= []).push(call);
    return;
  }
  messages.push({ role: "assistant", content: null, tool_calls: [call] });
}

function toChatTools(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    throw new Error("Responses token estimator payload tools must be an array.");
  }
  return value.map((rawTool, index) => {
    const path = `Responses token estimator tools[${index}]`;
    const tool = requireRecord(rawTool, path);
    if (tool.type !== "function") {
      throw new Error(`${path}.type must be "function".`);
    }
    return {
      type: "function",
      function: {
        name: requireString(tool.name, `${path}.name`),
        description: requireString(tool.description, `${path}.description`),
        parameters: requireRecord(tool.parameters, `${path}.parameters`),
      },
    };
  });
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw new Error(`${path} must be a string.`);
  }
  return value;
}
