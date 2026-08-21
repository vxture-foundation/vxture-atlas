import { HttpStatus, Inject, Injectable } from "@nestjs/common";

import { ClaudeProvider } from "../providers/claude.provider";
import { OpenAiCompatibleProvider } from "../providers/openai-compatible.provider";
import { normalizeProtocol } from "../providers/protocol";
import type { ModelProtocol } from "../providers/protocol";
import { ZhipuProvider } from "../providers/zhipu.provider";
import { ModelRuntimeException } from "../runtime/runtime.errors";
import type { IModelProvider } from "../types/runtime.types";

/**
 * 分发入参：路由需要的是模型这一整行，不再只是 provider code。
 * 用结构类型而不是 `AiModelRecord`，让调用方与测试不必构造一整行。
 */
export interface RoutableModel {
  provider: string;
  protocol: string;
  modelCode: string;
}

/**
 * 模型分发（docs/30-design/100-model-onboarding-and-protocol-adapters.md §7）。
 *
 * 两层，按顺序：
 *
 *   1. **特例层** —— 这家上游在协议之外还多支持了别的能力（智谱的
 *      embed/rerank）。仅仅参数不同不属于这一层，那是 `config.wire` 的事。
 *   2. **协议层** —— 正常路径。`protocol` 决定用哪个适配器，于是接入一家新的
 *      OpenAI 方言上游只需要一条注册表记录，不需要改代码、不需要发版。
 *
 * 协议无法归一化即 `MODEL_NOT_ROUTABLE`，没有静默兜底。
 */
@Injectable()
export class ModelRouterService {
  /** 第 1 层：协议之外还有额外能力的上游。 */
  private readonly specializations: ReadonlyMap<string, IModelProvider>;

  /** 第 2 层：协议 -> 适配器。 */
  private readonly byProtocol: ReadonlyMap<ModelProtocol, IModelProvider>;

  constructor(
    @Inject(OpenAiCompatibleProvider)
    openAiCompatibleProvider: OpenAiCompatibleProvider,
    @Inject(ClaudeProvider)
    claudeProvider: ClaudeProvider,
    @Inject(ZhipuProvider)
    zhipuProvider: ZhipuProvider,
  ) {
    this.specializations = new Map<string, IModelProvider>([
      // 智谱：chat 走通用协议，但另有真实的 embed / rerank。
      [zhipuProvider.providerName, zhipuProvider],
    ]);

    this.byProtocol = new Map<ModelProtocol, IModelProvider>([
      ["openai-chat-completions", openAiCompatibleProvider],
      ["anthropic-messages", claudeProvider],
    ]);
  }

  resolve(model: RoutableModel): IModelProvider {
    const specialization = this.specializations.get(model.provider);
    if (specialization) {
      return specialization;
    }

    const protocol = normalizeProtocol(model.protocol);
    if (protocol) {
      const provider = this.byProtocol.get(protocol);
      if (provider) {
        return provider;
      }
    }

    throw new ModelRuntimeException(
      HttpStatus.SERVICE_UNAVAILABLE,
      "MODEL_NOT_ROUTABLE",
      `AI model "${model.modelCode}" is not routable: unknown protocol "${model.protocol}" and no specialization for provider "${model.provider}"`,
      // protocol 只进 message，不进 metadata：`ModelRuntimeErrorResponse` 是
      // 回给 S2S 调用方的错误体，不该新增暴露注册表内部字段的契约。
      { modelCode: model.modelCode, provider: model.provider },
    );
  }
}
