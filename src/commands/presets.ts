/**
 * Curated command hints for popular game plugins (genshin / miao-plugin / StarRail-plugin / ZZZ-Plugin).
 * Nothing here is trusted blindly: at runtime every entry is tested against the live rule regexes and only
 * matching ones are offered to the LLM. `{角色}` is replaced by `example` for validation.
 */
export interface Preset {
  cmd: string
  desc: string
  game: 'gs' | 'sr' | 'zzz' | 'common'
  example?: string
  /** Concrete command used for validation when `cmd` needs an argument. */
  test?: string
  /** Synonym of another entry: still searchable/verifiable, not listed in the prompt. */
  hidden?: boolean
}

const GS = '刻晴'
const SR = '卡芙卡'
const ZZZ = '艾莲'

export const PRESETS: Preset[] = [
  // ---- 原神 ----
  { cmd: '#体力', desc: '原神实时便笺：树脂、每日委托、派遣、洞天宝钱', game: 'gs' },
  { cmd: '#深渊', desc: '原神本期深境螺旋战绩', game: 'gs' },
  { cmd: '#上期深渊', desc: '原神上期深境螺旋战绩', game: 'gs' },
  { cmd: '#幻想真境剧诗', desc: '原神幻想真境剧诗战绩', game: 'gs' },
  { cmd: '#剧诗', desc: '原神幻想真境剧诗战绩（简写）', game: 'gs', hidden: true },
  { cmd: '#幽境危战', desc: '原神幽境危战战绩', game: 'gs' },
  { cmd: '#角色', desc: '原神已拥有角色列表与练度', game: 'gs' },
  { cmd: '#练度统计', desc: '原神角色练度统计', game: 'gs' },
  { cmd: '#探索', desc: '原神各地区探索度', game: 'gs' },
  { cmd: '#原石', desc: '原神本月原石/摩拉收入（旅行札记）', game: 'gs' },
  { cmd: '#札记', desc: '原神旅行札记（原石摩拉收入）', game: 'gs', hidden: true },
  { cmd: '#面板', desc: '原神已缓存面板的角色列表', game: 'gs' },
  { cmd: '#更新面板', desc: '原神从展柜更新角色面板数据', game: 'gs' },
  { cmd: '#{角色}面板', desc: '原神查看某角色面板/圣遗物评分', game: 'gs', example: GS },
  { cmd: '#{角色}伤害', desc: '原神计算某角色伤害', game: 'gs', example: GS },
  { cmd: '#{角色}天赋', desc: '原神角色天赋介绍与材料', game: 'gs', example: GS },
  { cmd: '#{角色}命座', desc: '原神角色命之座介绍', game: 'gs', example: GS },
  { cmd: '#{角色}图鉴', desc: '原神角色图鉴资料', game: 'gs', example: GS },
  { cmd: '#{角色}攻略', desc: '原神角色攻略图', game: 'gs', example: GS },
  { cmd: '#{角色}材料', desc: '原神角色突破/天赋材料', game: 'gs', example: GS },
  { cmd: '#抽卡记录', desc: '原神角色池抽卡记录', game: 'gs' },
  { cmd: '#武器记录', desc: '原神武器池抽卡记录', game: 'gs' },
  { cmd: '#常驻记录', desc: '原神常驻池抽卡记录', game: 'gs' },
  { cmd: '#抽卡统计', desc: '原神全部卡池抽卡统计', game: 'gs' },
  { cmd: '#抽卡分析', desc: '原神抽卡记录分析', game: 'gs' },
  { cmd: '#今日素材', desc: '原神今天可刷的天赋/武器素材', game: 'gs' },
  { cmd: '#日历', desc: '原神活动日历', game: 'gs' },
  { cmd: '#uid', desc: '查看已绑定的原神uid', game: 'gs' },
  { cmd: '#绑定uid', desc: '绑定原神uid，格式 #绑定+uid，如 #绑定123456789', game: 'gs', test: '#绑定123456789' },
  { cmd: '#我的ck', desc: '查看已绑定的米游社cookie', game: 'gs' },
  { cmd: '#扫码登录', desc: '米游社扫码登录绑定账号', game: 'gs' },
  { cmd: '#尘歌壶', desc: '原神尘歌壶信息', game: 'gs' },
  { cmd: '#成就', desc: '原神成就统计', game: 'gs' },
  { cmd: '#卡池', desc: '原神当前/历史卡池信息', game: 'gs' },
  { cmd: '#喵喵帮助', desc: '喵喵插件帮助菜单', game: 'gs' },
  // ---- 星穹铁道 (* 前缀会被框架规范为 #星铁) ----
  { cmd: '*体力', desc: '星铁实时便笺：开拓力、每日实训、委托', game: 'sr' },
  { cmd: '*忘却之庭', desc: '星铁忘却之庭（混沌回忆）战绩', game: 'sr' },
  { cmd: '*混沌回忆', desc: '星铁混沌回忆战绩', game: 'sr', hidden: true },
  { cmd: '*虚构叙事', desc: '星铁虚构叙事战绩', game: 'sr' },
  { cmd: '*末日幻影', desc: '星铁末日幻影战绩', game: 'sr' },
  { cmd: '*异相仲裁', desc: '星铁异相仲裁战绩', game: 'sr' },
  { cmd: '*角色', desc: '星铁角色列表与练度', game: 'sr' },
  { cmd: '*面板', desc: '星铁已缓存面板角色列表', game: 'sr' },
  { cmd: '*更新面板', desc: '星铁更新角色面板', game: 'sr' },
  { cmd: '*{角色}面板', desc: '星铁查看某角色面板', game: 'sr', example: SR },
  { cmd: '*跃迁记录', desc: '星铁跃迁（抽卡）记录', game: 'sr' },
  { cmd: '*抽卡记录', desc: '星铁抽卡记录', game: 'sr', hidden: true },
  { cmd: '*抽卡分析', desc: '星铁抽卡分析', game: 'sr' },
  { cmd: '*星琼', desc: '星铁开拓月历（星琼收入）', game: 'sr' },
  { cmd: '*开拓月历', desc: '星铁开拓月历', game: 'sr' },
  { cmd: '*uid', desc: '查看已绑定的星铁uid', game: 'sr' },
  { cmd: '*帮助', desc: '星铁插件帮助', game: 'sr' },
  // ---- 绝区零 (% 前缀会被框架规范为 #绝区零) ----
  { cmd: '%体力', desc: '绝区零实时便笺：电量、每日活跃', game: 'zzz' },
  { cmd: '%便签', desc: '绝区零实时便笺', game: 'zzz', hidden: true },
  { cmd: '%深渊', desc: '绝区零式舆防卫战战绩', game: 'zzz', hidden: true },
  { cmd: '%式舆防卫战', desc: '绝区零式舆防卫战战绩', game: 'zzz' },
  { cmd: '%危局强袭战', desc: '绝区零危局强袭战战绩', game: 'zzz' },
  { cmd: '%角色', desc: '绝区零代理人列表', game: 'zzz' },
  { cmd: '%面板', desc: '绝区零已缓存面板列表', game: 'zzz' },
  { cmd: '%更新面板', desc: '绝区零更新代理人面板', game: 'zzz' },
  { cmd: '%{角色}面板', desc: '绝区零查看某代理人面板', game: 'zzz', example: ZZZ },
  { cmd: '%抽卡记录', desc: '绝区零调频（抽卡）记录', game: 'zzz' },
  { cmd: '%抽卡分析', desc: '绝区零抽卡分析', game: 'zzz' },
  { cmd: '%菲林', desc: '绝区零菲林收入（月报）', game: 'zzz' },
  { cmd: '%月报', desc: '绝区零月报', game: 'zzz', hidden: true },
  { cmd: '%uid', desc: '查看已绑定的绝区零uid', game: 'zzz' },
  { cmd: '%帮助', desc: '绝区零插件帮助', game: 'zzz' },
  // ---- 通用 ----
  { cmd: '#帮助', desc: '机器人总帮助菜单', game: 'common' },
  { cmd: '#状态', desc: '机器人运行状态', game: 'common' },
]

export const PLACEHOLDER = '{角色}'
