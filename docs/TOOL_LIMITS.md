# 工具额度

每轮工具结果附带单工具、全局次数和剩余轮数。普通工具的并行调用分别计数，失败、参数错误和未提供的工具请求仍消耗全局次数。

chat.maxToolCalls（默认20）只限制普通工具的调用次数；send_image、read_image、load_skill、list_stickers 是辅助工具，不占这个次数。chat.maxToolRounds（默认20）限制所有工具轮次：每次模型请求工具算一轮，只调用辅助工具的轮次也计入；轮数用完后还有一次请求用于给出最终回复。普通次数耗尽后仍可调用辅助工具；maxToolCalls=0 只保留辅助工具，maxToolRounds=0 或 tools.enable=false 关闭全部工具。一次回复中提供给模型的工具列表保持不变，以免使提示缓存失效；超出上限的调用不会执行，而是返回错误结果。单工具次数在 tools.sendImage.maxPerTurn（默认2）、tools.readImage.maxPerTurn（默认8）、tools.loadSkill.maxPerTurn（默认8）、tools.listStickers.maxPerTurn（默认4）中设置；范围0–32，0禁用对应工具。网页「配置 → 工具 → 对应工具」可修改，工具列表展示当前上限。初始工具描述附带上限，每次工具结果报告独立剩余次数；失败或无效参数也占用该工具次数，并行调用先同步扣除，批次结束后报告一致余量。

run_code 只返回代码输出，不扫描图片；需要时由代码打印路径。render_html 返回已保存图片路径；这两者都不占发送额度。send_image 明确选择要附在最终文字之后的图片，每次回复默认最多2次请求（可配置），最多2张图。computer_result 已移除，电脑截图同样使用 send_image。add_sticker 必须指定 path，不自动选择当前消息中的图片。render_html 和本地路径 send_image 无需 WSL 或代码沙盒，公网 URL 下载仍受 webFetch.enable 控制。供应商内置搜索由供应商配置控制。
