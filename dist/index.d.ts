declare class PluginBase {
    init: YunzaiPluginInit;
    e: YunzaiEvent;
    constructor(init: YunzaiPluginInit);
    reply(msg: any, quote?: boolean, data?: any): Promise<any>;
}

/**
 * Yunzai 全局对象类型声明
 */
declare global {
    const plugin: typeof PluginBase;
    const logger: {
        info(...args: any[]): void;
        warn(...args: any[]): void;
        error(...args: any[]): void;
        mark(...args: any[]): void;
        debug(...args: any[]): void;
        red(str: string): string;
        green(str: string): string;
        yellow(str: string): string;
        blue(str: string): string;
        cyan(str: string): string;
        magenta(str: string): string;
    };
    const Bot: Record<string, any>;
}
interface YunzaiRule {
    reg: string | RegExp;
    fnc: string;
    permission?: 'master' | 'admin' | 'all';
    event?: string;
}
interface YunzaiPluginInit {
    name: string;
    dsc?: string;
    event?: string;
    priority?: number;
    rule?: YunzaiRule[];
}
interface YunzaiEvent {
    msg?: string;
    raw_message?: string;
    user_id?: string | number;
    group_id?: string | number;
    isGroup?: boolean;
    atBot?: boolean;
    atme?: boolean;
    at?: string | number;
    self_id?: string | number;
    sender?: {
        user_id?: string | number;
        nickname?: string;
        card?: string;
    };
    reply(msg: any, quote?: boolean, data?: any): Promise<any>;
}

declare const BasePlugin$1: any;
declare class LLMChat extends BasePlugin$1 {
    constructor();
    /**
     * 通过 #chat 或 #ai 指令触发
     */
    onChatCommand(): Promise<boolean>;
    /**
     * 群聊中 @机器人 时自动触发
     */
    onAtMessage(): Promise<boolean>;
    /**
     * 请求 LLM 并回复
     */
    replyLLM(e: YunzaiEvent, query: string): Promise<boolean>;
}

declare const BasePlugin: any;
declare class LLMManage extends BasePlugin {
    constructor();
    help(): Promise<boolean>;
    status(): Promise<boolean>;
    clearMemory(): Promise<boolean>;
    switchModel(): Promise<boolean>;
    setSystemPrompt(): Promise<boolean>;
}

declare const apps: {
    chat: typeof LLMChat;
    manage: typeof LLMManage;
};

export { LLMChat, LLMManage, apps };
