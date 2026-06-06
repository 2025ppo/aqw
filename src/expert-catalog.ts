export type ExpertToolProfile =
  | "research"
  | "engineering"
  | "analysis"
  | "creative"
  | "documentation"
  | "review";

export type ExpertGender = "male" | "female";

export interface ExpertCatalogEntry {
  id: string;
  code: string;
  name: string;
  gender: ExpertGender;
  title: string;
  description: string;
  categoryId: string;
  categoryLabel: string;
  keywords: string[];
  toolProfile: ExpertToolProfile;
  promptFocus?: string[];
  systemRole?: boolean;
}

export type ExpertActivationLevel = "high" | "medium" | "low";
export interface ExpertActivationResult {
  score: number;
  level: ExpertActivationLevel;
  probability: number;
}

interface ExpertSpecializationProfile {
  knowledge: string[];
  methodology: string[];
  promptFocus?: string[];
}

export interface ExpertSpecializationSummary {
  knowledge: string[];
  methodology: string[];
  promptFocus: string[];
}

const DISCIPLINE_DISPLAY_NAMES: Record<string, string> = {
  "discipline-110": "数学",
  "discipline-120": "信息科学与系统科学",
  "discipline-130": "力学",
  "discipline-140": "物理学",
  "discipline-150": "化学",
  "discipline-160": "天文学",
  "discipline-170": "地球科学",
  "discipline-180": "生物学",
  "discipline-190": "心理学",
  "discipline-210": "农学",
  "discipline-220": "林学",
  "discipline-230": "畜牧、兽医科学",
  "discipline-240": "水产学",
  "discipline-310": "基础医学",
  "discipline-320": "临床医学",
  "discipline-330": "预防医学与公共卫生学",
  "discipline-340": "军事医学与特种医学",
  "discipline-350": "药学",
  "discipline-360": "中医学与中药学",
  "discipline-410": "工程与技术科学基础学科",
  "discipline-413": "信息与系统科学相关工程与技术",
  "discipline-416": "自然科学相关工程与技术",
  "discipline-420": "测绘科学技术",
  "discipline-430": "材料科学",
  "discipline-440": "矿山工程技术",
  "discipline-450": "冶金工程技术",
  "discipline-460": "机械工程",
  "discipline-470": "动力与电气工程",
  "discipline-480": "能源科学技术",
  "discipline-490": "核科学技术",
  "discipline-510": "电子与通信技术",
  "discipline-520": "计算机科学技术",
  "discipline-530": "化学工程",
  "discipline-535": "产品应用相关工程与技术",
  "discipline-540": "纺织科学技术",
  "discipline-550": "食品科学技术",
  "discipline-560": "土木建筑工程",
  "discipline-570": "水利工程",
  "discipline-580": "交通运输工程",
  "discipline-590": "航空、航天科学技术",
  "discipline-610": "环境科学技术及资源科学技术",
  "discipline-620": "安全科学技术",
  "discipline-630": "管理学",
  "discipline-710": "马克思主义",
  "discipline-720": "哲学",
  "discipline-730": "宗教学",
  "discipline-740": "语言学",
  "discipline-750": "文学",
  "discipline-760": "艺术学",
  "discipline-770": "历史学",
  "discipline-780": "考古学",
  "discipline-790": "经济学",
  "discipline-810": "政治学",
  "discipline-820": "法学",
  "discipline-830": "军事学",
  "discipline-840": "社会学",
  "discipline-850": "民族学与文化学",
  "discipline-860": "新闻与传播学",
  "discipline-870": "图书馆、情报与文献学",
  "discipline-880": "教育学",
  "discipline-890": "体育科学",
  "discipline-910": "统计学",
};

export function getDisciplineDisplayName(expertId: string): string | undefined {
  return DISCIPLINE_DISPLAY_NAMES[expertId];
}

const SYSTEM_EXPERTS: ExpertCatalogEntry[] = [
  {
    id: "jiang-xingtu",
    code: "SYS-001",
    name: "江星图",
    gender: "male",
    title: "主管",
    description: "负责目标拆解、候选专家筛选、阶段协调与最终交付复核。",
    categoryId: "system",
    categoryLabel: "系统角色",
    keywords: ["调度", "拆解", "协调", "复核"],
    toolProfile: "review",
    systemRole: true,
  },
  {
    id: "jiang-xinghe",
    code: "SYS-002",
    name: "江星河",
    gender: "female",
    title: "助手",
    description: "负责知识整理、仓库摘要、上下文压缩与系统级辅助分析。",
    categoryId: "system",
    categoryLabel: "系统角色",
    keywords: ["压缩", "知识库", "摘要", "系统"],
    toolProfile: "documentation",
    systemRole: true,
  },
];

const DISCIPLINE_EXPERTS: ExpertCatalogEntry[] = [
  { id: "discipline-110", code: "110", name: "江昊天",
    gender: "male",
    title: "一级学科专家", description: "负责数学建模、证明推导、优化方法与形式化分析。", categoryId: "natural", categoryLabel: "A. 自然科学", keywords: ["数学", "建模", "证明", "优化", "方程", "算法"], toolProfile: "analysis" },
  { id: "discipline-120", code: "120", name: "江雅婷",
    gender: "female",
    title: "一级学科专家", description: "负责系统论、信息论、复杂系统与跨学科信息建模。", categoryId: "natural", categoryLabel: "A. 自然科学", keywords: ["信息科学", "系统科学", "系统论", "信息论", "复杂系统", "架构"], toolProfile: "analysis" },
  { id: "discipline-130", code: "130", name: "江宇轩",
    gender: "male",
    title: "一级学科专家", description: "负责受力分析、结构响应、运动规律与工程力学判断。", categoryId: "natural", categoryLabel: "A. 自然科学", keywords: ["力学", "应力", "应变", "结构", "动力学", "运动"], toolProfile: "research" },
  { id: "discipline-140", code: "140", name: "江雨薇",
    gender: "female",
    title: "一级学科专家", description: "负责物理机理、实验解释、定量计算与理论推演。", categoryId: "natural", categoryLabel: "A. 自然科学", keywords: ["物理", "能量", "电磁", "量子", "实验", "机理"], toolProfile: "research" },
  { id: "discipline-150", code: "150", name: "江辰宇",
    gender: "male",
    title: "一级学科专家", description: "负责化学反应、材料组成、实验路径与安全条件分析。", categoryId: "natural", categoryLabel: "A. 自然科学", keywords: ["化学", "反应", "分子", "催化", "材料", "实验"], toolProfile: "research" },
  { id: "discipline-160", code: "160", name: "江静雅",
    gender: "female",
    title: "一级学科专家", description: "负责天体观测、宇宙演化、轨道机制与天文数据解读。", categoryId: "natural", categoryLabel: "A. 自然科学", keywords: ["天文学", "宇宙", "恒星", "星系", "轨道", "观测"], toolProfile: "research" },
  { id: "discipline-170", code: "170", name: "江彦霖",
    gender: "male",
    title: "一级学科专家", description: "负责地质、地貌、气候、海洋与地球系统过程分析。", categoryId: "natural", categoryLabel: "A. 自然科学", keywords: ["地球科学", "地质", "气候", "地震", "海洋", "地貌"], toolProfile: "research" },
  { id: "discipline-180", code: "180", name: "江思敏",
    gender: "female",
    title: "一级学科专家", description: "负责生命过程、遗传机制、生态关系与生物实验分析。", categoryId: "natural", categoryLabel: "A. 自然科学", keywords: ["生物学", "遗传", "细胞", "生态", "进化", "实验"], toolProfile: "research" },
  { id: "discipline-190", code: "190", name: "江睿哲",
    gender: "male",
    title: "一级学科专家", description: "负责认知、行为、动机、体验与人机交互心理分析。", categoryId: "natural", categoryLabel: "A. 自然科学", keywords: ["心理学", "认知", "行为", "体验", "动机", "用户研究"], toolProfile: "analysis" },
  { id: "discipline-210", code: "210", name: "江晴雪",
    gender: "female",
    title: "一级学科专家", description: "负责作物生产、土壤管理、农业系统与农艺方案分析。", categoryId: "agriculture", categoryLabel: "B. 农业科学", keywords: ["农学", "作物", "农业", "耕作", "土壤", "农艺"], toolProfile: "research" },
  { id: "discipline-220", code: "220", name: "江俊逸",
    gender: "male",
    title: "一级学科专家", description: "负责森林生态、林木培育、资源保护与林业经营判断。", categoryId: "agriculture", categoryLabel: "B. 农业科学", keywords: ["林学", "森林", "林木", "生态保护", "林业", "资源"], toolProfile: "research" },
  { id: "discipline-230", code: "230", name: "江婉清",
    gender: "female",
    title: "一级学科专家", description: "负责动物生产、动物健康、疫病防治与养殖体系分析。", categoryId: "agriculture", categoryLabel: "B. 农业科学", keywords: ["畜牧", "兽医", "动物", "养殖", "疫病", "饲养"], toolProfile: "research" },
  { id: "discipline-240", code: "240", name: "江景天",
    gender: "male",
    title: "一级学科专家", description: "负责水域养殖、渔业资源、水产健康与产业方案分析。", categoryId: "agriculture", categoryLabel: "B. 农业科学", keywords: ["水产", "渔业", "养殖", "水域", "海产", "淡水"], toolProfile: "research" },
  { id: "discipline-310", code: "310", name: "江书萱",
    gender: "female",
    title: "一级学科专家", description: "负责病理机制、生理基础、实验医学与医学证据整理。", categoryId: "medical", categoryLabel: "C. 医药科学", keywords: ["基础医学", "病理", "生理", "解剖", "实验医学", "机制"], toolProfile: "research" },
  { id: "discipline-320", code: "320", name: "江天佑",
    gender: "male",
    title: "一级学科专家", description: "负责临床路径、诊疗逻辑、病例判断与证据汇总。", categoryId: "medical", categoryLabel: "C. 医药科学", keywords: ["临床医学", "病例", "诊疗", "症状", "手术", "指南"], toolProfile: "research" },
  { id: "discipline-330", code: "330", name: "江梦琪",
    gender: "female",
    title: "一级学科专家", description: "负责流行病学、风险防控、群体健康与公共卫生策略。", categoryId: "medical", categoryLabel: "C. 医药科学", keywords: ["公共卫生", "预防医学", "流行病学", "风险防控", "疾病监测", "健康"], toolProfile: "research" },
  { id: "discipline-340", code: "340", name: "江承熙",
    gender: "male",
    title: "一级学科专家", description: "负责极端环境医学、特种伤病与应急医学支持分析。", categoryId: "medical", categoryLabel: "C. 医药科学", keywords: ["军事医学", "特种医学", "应急医学", "创伤", "极端环境", "救治"], toolProfile: "research" },
  { id: "discipline-350", code: "350", name: "江思彤",
    gender: "female",
    title: "一级学科专家", description: "负责药物机理、药代动力学、药剂设计与药物评价分析。", categoryId: "medical", categoryLabel: "C. 医药科学", keywords: ["药学", "药物", "药代", "药效", "制剂", "药理"], toolProfile: "research" },
  { id: "discipline-360", code: "360", name: "江柏然",
    gender: "male",
    title: "一级学科专家", description: "负责中医辨证、中药配伍、传统医学理论与应用分析。", categoryId: "medical", categoryLabel: "C. 医药科学", keywords: ["中医", "中药", "辨证", "方剂", "经络", "药材"], toolProfile: "research" },
  { id: "discipline-410", code: "410", name: "江依琳",
    gender: "female",
    title: "一级学科专家", description: "负责工程共性原理、技术路线、约束建模与系统落地判断。", categoryId: "engineering", categoryLabel: "D. 工程与技术科学", keywords: ["工程基础", "技术路线", "系统工程", "约束", "方案", "实现"], toolProfile: "engineering" },
  { id: "discipline-413", code: "413", name: "郭子昂",
    gender: "male",
    title: "一级学科专家", description: "负责信息系统、平台架构、工作流编排与系统协同优化。", categoryId: "engineering", categoryLabel: "D. 工程与技术科学", keywords: ["信息系统", "系统工程", "工作流", "调度", "架构", "平台"], toolProfile: "engineering" },
  { id: "discipline-416", code: "416", name: "郭晓霜",
    gender: "female",
    title: "一级学科专家", description: "负责将自然科学原理转化为工程方案与验证路径。", categoryId: "engineering", categoryLabel: "D. 工程与技术科学", keywords: ["自然科学工程", "实验转化", "工程验证", "技术方案", "机理落地"], toolProfile: "engineering" },
  { id: "discipline-420", code: "420", name: "郭文轩",
    gender: "male",
    title: "一级学科专家", description: "负责空间测量、定位、遥感与地理信息工程分析。", categoryId: "engineering", categoryLabel: "D. 工程与技术科学", keywords: ["测绘", "遥感", "地理信息", "定位", "地图", "GIS"], toolProfile: "engineering" },
  { id: "discipline-430", code: "430", name: "郭沛怡",
    gender: "female",
    title: "一级学科专家", description: "负责材料结构、性能评估、工艺路线与选材建议。", categoryId: "engineering", categoryLabel: "D. 工程与技术科学", keywords: ["材料", "材料科学", "选材", "性能", "工艺", "结构"], toolProfile: "engineering" },
  { id: "discipline-440", code: "440", name: "郭浩然",
    gender: "male",
    title: "一级学科专家", description: "负责矿产开采、地质工程、安全风险与矿山系统分析。", categoryId: "engineering", categoryLabel: "D. 工程与技术科学", keywords: ["矿山", "采矿", "开采", "矿产", "井下", "安全"], toolProfile: "engineering" },
  { id: "discipline-450", code: "450", name: "郭心蕾",
    gender: "female",
    title: "一级学科专家", description: "负责冶炼工艺、金属材料、过程控制与产线优化分析。", categoryId: "engineering", categoryLabel: "D. 工程与技术科学", keywords: ["冶金", "金属", "冶炼", "炼钢", "工艺控制", "材料"], toolProfile: "engineering" },
  { id: "discipline-460", code: "460", name: "郭晨逸",
    gender: "male",
    title: "一级学科专家", description: "负责机械结构、制造工艺、传动控制与设备优化分析。", categoryId: "engineering", categoryLabel: "D. 工程与技术科学", keywords: ["机械工程", "结构设计", "制造", "传动", "设备", "装配"], toolProfile: "engineering" },
  { id: "discipline-470", code: "470", name: "郭子涵",
    gender: "female",
    title: "一级学科专家", description: "负责动力系统、电气控制、供配电与机电协同分析。", categoryId: "engineering", categoryLabel: "D. 工程与技术科学", keywords: ["电气", "动力", "供电", "控制系统", "机电", "电机"], toolProfile: "engineering" },
  { id: "discipline-480", code: "480", name: "郭嘉泽",
    gender: "male",
    title: "一级学科专家", description: "负责能源转换、储能方案、能源系统与效率优化分析。", categoryId: "engineering", categoryLabel: "D. 工程与技术科学", keywords: ["能源", "储能", "电池", "发电", "能效", "能源系统"], toolProfile: "engineering" },
  { id: "discipline-490", code: "490", name: "郭梦瑶",
    gender: "female",
    title: "一级学科专家", description: "负责核能应用、辐射安全、核工程与高可靠性分析。", categoryId: "engineering", categoryLabel: "D. 工程与技术科学", keywords: ["核科学", "核工程", "辐射", "反应堆", "核安全", "核能"], toolProfile: "engineering" },
  { id: "discipline-510", code: "510", name: "郭志远",
    gender: "male",
    title: "一级学科专家", description: "负责电路、通信链路、信号系统与电子实现分析。", categoryId: "engineering", categoryLabel: "D. 工程与技术科学", keywords: ["电子", "通信", "信号", "射频", "电路", "网络协议"], toolProfile: "engineering" },
  { id: "discipline-520", code: "520", name: "郭晓月",
    gender: "female",
    title: "一级学科专家", description: "负责软件架构、代码实现、算法设计、系统重构与工程落地。", categoryId: "engineering", categoryLabel: "D. 工程与技术科学", keywords: ["计算机", "代码", "软件", "前端", "后端", "数据库", "程序", "重构", "架构", "引擎"], toolProfile: "engineering", promptFocus: ["主项目代码改造", "工程实现", "系统设计"] },
  { id: "discipline-530", code: "530", name: "郭宇航",
    gender: "male",
    title: "一级学科专家", description: "负责化工流程、单元操作、过程放大与工业安全分析。", categoryId: "engineering", categoryLabel: "D. 工程与技术科学", keywords: ["化学工程", "化工", "流程", "反应器", "分离", "工业"], toolProfile: "engineering" },
  { id: "discipline-535", code: "535", name: "郭佳宁",
    gender: "female",
    title: "一级学科专家", description: "负责产品级应用集成、场景适配、交付体验与应用化落地。", categoryId: "engineering", categoryLabel: "D. 工程与技术科学", keywords: ["产品应用", "交付", "应用工程", "用户场景", "体验", "产品化"], toolProfile: "engineering" },
  { id: "discipline-540", code: "540", name: "郭鸿熙",
    gender: "male",
    title: "一级学科专家", description: "负责纤维材料、织造工艺、染整流程与功能性评估。", categoryId: "engineering", categoryLabel: "D. 工程与技术科学", keywords: ["纺织", "纤维", "织造", "染整", "面料", "功能材料"], toolProfile: "engineering" },
  { id: "discipline-550", code: "550", name: "郭芷若",
    gender: "female",
    title: "一级学科专家", description: "负责食品工艺、营养评价、品质控制与安全分析。", categoryId: "engineering", categoryLabel: "D. 工程与技术科学", keywords: ["食品", "营养", "加工", "保鲜", "品质控制", "食品安全"], toolProfile: "engineering" },
  { id: "discipline-560", code: "560", name: "郭泽宇",
    gender: "male",
    title: "一级学科专家", description: "负责土木结构、建筑系统、施工组织与耐久性分析。", categoryId: "engineering", categoryLabel: "D. 工程与技术科学", keywords: ["土木", "建筑", "结构", "施工", "工程图", "耐久"], toolProfile: "engineering" },
  { id: "discipline-570", code: "570", name: "郭乐蓉",
    gender: "female",
    title: "一级学科专家", description: "负责水资源、水工结构、防洪排涝与流域治理分析。", categoryId: "engineering", categoryLabel: "D. 工程与技术科学", keywords: ["水利", "水工", "流域", "防洪", "灌溉", "水资源"], toolProfile: "engineering" },
  { id: "discipline-580", code: "580", name: "郭逸凡",
    gender: "male",
    title: "一级学科专家", description: "负责交通系统、运输组织、路径规划与设施优化分析。", categoryId: "engineering", categoryLabel: "D. 工程与技术科学", keywords: ["交通", "运输", "物流", "路径规划", "轨道", "调度"], toolProfile: "engineering" },
  { id: "discipline-590", code: "590", name: "郭诗涵",
    gender: "female",
    title: "一级学科专家", description: "负责飞行器系统、航天任务、可靠性与极端环境工程分析。", categoryId: "engineering", categoryLabel: "D. 工程与技术科学", keywords: ["航空", "航天", "飞行器", "轨道", "可靠性", "控制"], toolProfile: "engineering" },
  { id: "discipline-610", code: "610", name: "苏弘文",
    gender: "male",
    title: "一级学科专家", description: "负责环境治理、资源循环、污染控制与可持续方案分析。", categoryId: "engineering", categoryLabel: "D. 工程与技术科学", keywords: ["环境", "资源", "污染治理", "可持续", "碳排", "生态工程"], toolProfile: "engineering" },
  { id: "discipline-620", code: "620", name: "郭安然",
    gender: "female",
    title: "一级学科专家", description: "负责风险识别、故障预防、安全策略与高危系统分析。", categoryId: "engineering", categoryLabel: "D. 工程与技术科学", keywords: ["安全科学", "风险", "故障", "应急", "安全策略", "可靠性"], toolProfile: "review" },
  { id: "discipline-630", code: "630", name: "苏思远",
    gender: "male",
    title: "一级学科专家", description: "负责组织协同、流程治理、资源配置与管理机制设计。", categoryId: "engineering", categoryLabel: "D. 工程与技术科学", keywords: ["管理学", "流程", "组织", "资源配置", "项目管理", "治理"], toolProfile: "analysis" },
  { id: "discipline-710", code: "710", name: "苏语嫣",
    gender: "female",
    title: "一级学科专家", description: "负责经典理论、社会结构分析与思想脉络梳理。", categoryId: "humanities", categoryLabel: "E. 人文与社会科学", keywords: ["马克思主义", "政治经济学", "历史唯物主义", "理论"], toolProfile: "research" },
  { id: "discipline-720", code: "720", name: "苏子衿",
    gender: "male",
    title: "一级学科专家", description: "负责概念辨析、逻辑结构、思想比较与方法论反思。", categoryId: "humanities", categoryLabel: "E. 人文与社会科学", keywords: ["哲学", "逻辑", "伦理", "本体论", "认识论", "概念"], toolProfile: "analysis" },
  { id: "discipline-730", code: "730", name: "苏亦菲",
    gender: "female",
    title: "一级学科专家", description: "负责宗教传统、仪式体系、思想演变与文化比较分析。", categoryId: "humanities", categoryLabel: "E. 人文与社会科学", keywords: ["宗教学", "宗教", "信仰", "仪式", "神学", "文化"], toolProfile: "research" },
  { id: "discipline-740", code: "740", name: "苏文博",
    gender: "male",
    title: "一级学科专家", description: "负责语言结构、语义语用、翻译判断与跨语种表达优化。", categoryId: "humanities", categoryLabel: "E. 人文与社会科学", keywords: ["语言学", "翻译", "语法", "语义", "术语", "语言"], toolProfile: "documentation" },
  { id: "discipline-750", code: "750", name: "苏若彤",
    gender: "female",
    title: "一级学科专家", description: "负责文体写作、文本修辞、叙事结构与风格打磨。", categoryId: "humanities", categoryLabel: "E. 人文与社会科学", keywords: ["文学", "写作", "文案", "叙事", "修辞", "润色"], toolProfile: "creative" },
  { id: "discipline-760", code: "760", name: "苏明轩",
    gender: "male",
    title: "一级学科专家", description: "负责视觉语言、审美风格、媒介表达与创意方案设计。", categoryId: "humanities", categoryLabel: "E. 人文与社会科学", keywords: ["艺术", "视觉", "审美", "设计", "海报", "视频", "图像", "风格"], toolProfile: "creative" },
  { id: "discipline-770", code: "770", name: "苏子薇",
    gender: "female",
    title: "一级学科专家", description: "负责历史脉络、事件比较、史料梳理与背景解释。", categoryId: "humanities", categoryLabel: "E. 人文与社会科学", keywords: ["历史学", "历史", "史料", "演变", "时代背景", "事件"], toolProfile: "research" },
  { id: "discipline-780", code: "780", name: "苏景行",
    gender: "male",
    title: "一级学科专家", description: "负责遗址遗物、文化层序、物质证据与考古解释。", categoryId: "humanities", categoryLabel: "E. 人文与社会科学", keywords: ["考古", "遗址", "文物", "层位", "器物", "年代"], toolProfile: "research" },
  { id: "discipline-790", code: "790", name: "苏曼丽",
    gender: "female",
    title: "一级学科专家", description: "负责经济机制、市场行为、政策影响与成本收益分析。", categoryId: "humanities", categoryLabel: "E. 人文与社会科学", keywords: ["经济学", "市场", "供需", "成本", "政策", "产业"], toolProfile: "analysis" },
  { id: "discipline-810", code: "810", name: "苏俊凯",
    gender: "male",
    title: "一级学科专家", description: "负责制度结构、治理关系、政策议程与政治过程分析。", categoryId: "humanities", categoryLabel: "E. 人文与社会科学", keywords: ["政治学", "治理", "制度", "政策", "政府", "国际关系"], toolProfile: "analysis" },
  { id: "discipline-820", code: "820", name: "苏佳怡",
    gender: "female",
    title: "一级学科专家", description: "负责法律规则、合规边界、责任结构与文本审查判断。", categoryId: "humanities", categoryLabel: "E. 人文与社会科学", keywords: ["法学", "法律", "合规", "条款", "责任", "审查"], toolProfile: "review" },
  { id: "discipline-830", code: "830", name: "苏泰文",
    gender: "male",
    title: "一级学科专家", description: "负责战略规划、对抗体系、作战逻辑与军事实践分析。", categoryId: "humanities", categoryLabel: "E. 人文与社会科学", keywords: ["军事学", "战略", "战术", "对抗", "军队", "防务"], toolProfile: "analysis" },
  { id: "discipline-840", code: "840", name: "苏雪珊",
    gender: "female",
    title: "一级学科专家", description: "负责社会结构、群体行为、制度关系与社会调查分析。", categoryId: "humanities", categoryLabel: "E. 人文与社会科学", keywords: ["社会学", "群体", "社区", "制度", "社会结构", "调查"], toolProfile: "analysis" },
  { id: "discipline-850", code: "850", name: "苏宇宸",
    gender: "male",
    title: "一级学科专家", description: "负责文化差异、族群经验、田野视角与文化解释分析。", categoryId: "humanities", categoryLabel: "E. 人文与社会科学", keywords: ["民族学", "文化学", "文化差异", "田野", "族群", "习俗"], toolProfile: "research" },
  { id: "discipline-860", code: "860", name: "苏晓萱",
    gender: "female",
    title: "一级学科专家", description: "负责传播策略、内容表达、媒介效果与舆论路径分析。", categoryId: "humanities", categoryLabel: "E. 人文与社会科学", keywords: ["传播学", "新闻学", "媒介", "传播", "舆情", "内容策略"], toolProfile: "documentation" },
  { id: "discipline-870", code: "870", name: "苏浩轩",
    gender: "male",
    title: "一级学科专家", description: "负责资料检索、文献整理、知识编目与档案结构化。", categoryId: "humanities", categoryLabel: "E. 人文与社会科学", keywords: ["文献", "图书馆", "情报", "资料整理", "档案", "检索"], toolProfile: "documentation" },
  { id: "discipline-880", code: "880", name: "苏婉君",
    gender: "female",
    title: "一级学科专家", description: "负责教学设计、学习路径、课程结构与认知负担优化。", categoryId: "humanities", categoryLabel: "E. 人文与社会科学", keywords: ["教育学", "教学", "课程", "学习", "训练", "培养"], toolProfile: "analysis" },
  { id: "discipline-890", code: "890", name: "苏俊驰",
    gender: "male",
    title: "一级学科专家", description: "负责训练方法、运动表现、体能恢复与竞技分析。", categoryId: "humanities", categoryLabel: "E. 人文与社会科学", keywords: ["体育", "训练", "运动", "体能", "恢复", "竞技"], toolProfile: "analysis" },
  { id: "discipline-910", code: "910", name: "苏馨月",
    gender: "female",
    title: "一级学科专家", description: "负责数据建模、统计推断、实验设计与量化证据判断。", categoryId: "humanities", categoryLabel: "E. 人文与社会科学", keywords: ["统计学", "数据分析", "回归", "显著性", "实验设计", "建模"], toolProfile: "analysis" },
];

export const CORE_EXPERT_IDS = ["jiang-xingtu", "jiang-xinghe", "discipline-520"];
export const QUOTA_EXEMPT_IDS = ["jiang-xingtu", "jiang-xinghe"];

const SCENE_DEFAULT_EXPERT_IDS: Record<string, string[]> = {
  "code-development": ["discipline-520"],
  "code-review": ["discipline-520", "discipline-620"],
  "technical-research": ["discipline-120"],
  "design": ["discipline-760", "discipline-190"],
  "quick-answer": [],
  "translation": ["discipline-740"],
  "writing": ["discipline-750"],
  "office": ["discipline-630", "discipline-870"],
  "data-analysis": ["discipline-910"],
  "document-processing": ["discipline-870"],
  "media-creation": ["discipline-760"],
  "video-production": ["discipline-760"],
  "research-with-search": ["discipline-120"],
  "disciplinary-analysis": ["discipline-120"],
};

const ALL_EXPERT_TOOL_IDS = [
  "shell_exec",
  "file_read",
  "file_write",
  "file_patch",
  "file_list",
  "web_search",
  "memory_query",
  "index_search",
];

const SPECIALIZATION_PROFILES: Record<string, ExpertSpecializationProfile> = {
  "discipline-110": { knowledge: ["常见数学建模范式、约束表达与目标函数构造。", "证明、反例、收敛性与复杂度分析的基本判据。"], methodology: ["先抽象变量、约束和目标，再选模型。", "当结论依赖推导时，优先给可复核的中间步骤。"] },
  "discipline-120": { knowledge: ["系统边界、反馈回路、信息流与耦合关系的典型分析框架。", "复杂系统、调度系统与跨模块协同的常见失稳点。"], methodology: ["先画清对象、关系和流向，再讨论优化。", "优先识别瓶颈、耦合点和可分层抽象的部分。"] },
  "discipline-130": { knowledge: ["静力学、动力学、材料响应与结构安全的基本判据。", "受力路径、边界条件和极端载荷下的失效模式。"], methodology: ["先明确载荷、边界和支撑条件。", "结论要区分理论近似与实际工程安全裕度。"] },
  "discipline-140": { knowledge: ["能量、场、粒子、测量与实验误差的核心概念。", "常见物理模型适用范围与近似条件。"], methodology: ["先判断物理主导机理，再选择模型。", "定量结论要注明近似前提和单位量纲。"] },
  "discipline-150": { knowledge: ["反应路径、物质组成、平衡条件与实验安全边界。", "材料与分子层面的结构-性质关系。"], methodology: ["先厘清物质体系和反应条件。", "同时评估产率、杂质和安全风险。"] },
  "discipline-160": { knowledge: ["天体分类、轨道规律、观测窗口与常见天文数据口径。", "观测误差、坐标系转换和时间尺度影响。"], methodology: ["先确定观测对象和时空尺度。", "解释数据时区分观测事实与理论推断。"] },
  "discipline-170": { knowledge: ["地质过程、地貌演化、气候系统与海陆圈相互作用。", "地球系统中的长期趋势与突发事件差异。"], methodology: ["先识别地球系统层级与时间尺度。", "把局部现象放回区域和系统背景中解释。"] },
  "discipline-180": { knowledge: ["细胞、遗传、生态与进化层面的关键证据链。", "实验生物学与观察生物学常见结论边界。"], methodology: ["先区分分子、个体、群体哪个层级在主导。", "避免把相关性直接等同为因果性。"] },
  "discipline-190": { knowledge: ["认知、动机、行为与体验评价的常见模型。", "用户研究、心理测量与实验设计的偏差来源。"], methodology: ["先区分主观体验、可观测行为和外部情境。", "优先用可验证证据支撑心理推断。"] },
  "discipline-210": { knowledge: ["作物生长、土壤肥力、水肥管理与农艺制度。", "农业生产中的季节性约束与病虫害风险。"], methodology: ["先确认作物、气候和土壤条件。", "方案要兼顾产量、成本和可实施性。"] },
  "discipline-220": { knowledge: ["森林生态、树种配置、资源保护与经营周期。", "林地环境对病害、更新和碳汇的影响。"], methodology: ["先明确林分结构和生态目标。", "把短期经营与长期生态影响一起评估。"] },
  "discipline-230": { knowledge: ["动物营养、生产性能、疫病防控与养殖管理。", "畜牧与兽医环节中的健康监测指标。"], methodology: ["先区分生产问题还是健康问题。", "同时看个体状态与群体管理条件。"] },
  "discipline-240": { knowledge: ["养殖水体、种苗、病害与渔业资源评估。", "水产生产对温度、盐度、溶氧等环境因素的敏感性。"], methodology: ["先明确养殖环境和物种特性。", "结论需同时覆盖生态和产出两端。"] },
  "discipline-310": { knowledge: ["病理、生理、生化与实验模型的基本证据链。", "基础医学研究中机制推断与临床外推的边界。"], methodology: ["先判断研究对象处于哪个生物层级。", "把机制解释与证据强度分开表达。"] },
  "discipline-320": { knowledge: ["临床路径、症状体征、检查结果与鉴别逻辑。", "指南、病例经验与风险告知的基本框架。"], methodology: ["先梳理病程和关键症状节点。", "诊疗推断必须区分建议、证据和禁忌。"] },
  "discipline-330": { knowledge: ["流行病学指标、暴露因素、群体干预与监测体系。", "公共卫生策略中的分层风险与资源配置逻辑。"], methodology: ["先界定人群、时间窗和传播/暴露路径。", "优先从群体风险而非单个案例出发判断。"] },
  "discipline-340": { knowledge: ["极端环境伤病、创伤处置与应急医学流程。", "战创伤、灾害医学与特种作业环境下的医学约束。"], methodology: ["先判断环境特殊性是否改变常规处置。", "优先考虑时效、资源和伤情分级。"] },
  "discipline-350": { knowledge: ["药效、药代、剂型与药物相互作用。", "研发、评价和使用环节中的关键药学证据。"], methodology: ["先明确药物目标、作用机制和给药路径。", "同时审视疗效、安全和依从性。"] },
  "discipline-360": { knowledge: ["辨证论治、中药配伍、方剂结构与传统理论。", "中医证候与现代应用之间的转换难点。"], methodology: ["先辨病机和证候，再谈处置思路。", "表达时区分传统理论框架与现代证据口径。"] },
  "discipline-410": { knowledge: ["需求、约束、架构、验证与交付的共性工程框架。", "工程系统中可靠性、可维护性和成本的平衡。"], methodology: ["先列目标和约束，再拆工程路径。", "优先选择验证成本可控的最小实施方案。"] },
  "discipline-413": { knowledge: ["信息系统架构、流程编排、服务协同与接口治理。", "调度链路、状态同步和上下文膨胀的常见问题。"], methodology: ["先分清控制面、数据面和执行面。", "优先压缩耦合和跨模块噪声传播。"] , promptFocus: ["多专家调度", "上下文压缩", "工作流编排"]},
  "discipline-416": { knowledge: ["科学机理转工程验证的中间桥接环节。", "实验现象到技术方案转化时的关键失真点。"], methodology: ["先确认科学规律是否足以支持工程假设。", "把验证计划和落地路径一起给出。"] },
  "discipline-420": { knowledge: ["空间坐标、遥感影像、定位精度与 GIS 数据结构。", "测绘误差、投影转换与场景适用边界。"], methodology: ["先统一坐标和尺度口径。", "讨论结论时注明精度与数据来源限制。"] },
  "discipline-430": { knowledge: ["材料结构、工艺、性能与服役环境关系。", "选材、失效和加工约束的关键指标。"], methodology: ["先看性能目标，再看结构和工艺可达性。", "材料建议必须带使用环境假设。"] },
  "discipline-440": { knowledge: ["矿体条件、开采方式、通风排水与井下安全。", "资源开发与地质风险的耦合关系。"], methodology: ["先明确地质和作业环境。", "方案要同步覆盖产能与安全红线。"] },
  "discipline-450": { knowledge: ["冶炼流程、热工条件、成分控制与产线稳定性。", "金属提纯与能耗/质量平衡的关键点。"], methodology: ["先识别流程瓶颈和质量控制点。", "同时审视产率、能耗和安全。"] },
  "discipline-460": { knowledge: ["机构、传动、制造公差、装配和维护约束。", "机械系统中疲劳、振动和磨损的典型风险。"], methodology: ["先分解机构和运动链。", "结论要覆盖制造可行性与维护成本。"] },
  "discipline-470": { knowledge: ["电机、电力电子、供配电和控制环路基础。", "动力与电气系统的保护、稳定和冗余要求。"], methodology: ["先确认功率链和控制链。", "设计建议需同时考虑安全保护和响应性能。"] },
  "discipline-480": { knowledge: ["发电、储能、转换效率与系统调度逻辑。", "能源方案中的成本、效率和寿命权衡。"], methodology: ["先看负荷与供能场景。", "把效率、经济性和可持续性一起比较。"] },
  "discipline-490": { knowledge: ["核能系统、辐射防护、可靠性与失效后果。", "高风险工程中的分层防护和许可边界。"], methodology: ["先做最坏后果评估，再谈优化。", "所有建议都应显式纳入安全冗余。"] },
  "discipline-510": { knowledge: ["电路、通信协议、信号链路与电子实现约束。", "带宽、时延、抗干扰和功耗的常见权衡。"], methodology: ["先划清链路层次和瓶颈位置。", "建议需同时覆盖功能、稳定和实现成本。"] },
  "discipline-520": { knowledge: ["代码结构、模块边界、数据流、状态管理与构建链路。", "重构、回归验证、依赖关系和可维护性的关键风险。"], methodology: ["先读真实代码与目录，再定改动面。", "优先交付最小可执行改动并给验证路径。"] , promptFocus: ["主项目代码改造", "工程实现", "系统设计", "重构与回归验证"]},
  "discipline-530": { knowledge: ["单元操作、传热传质、反应与分离流程。", "放大、连续化和工业安全中的常见问题。"], methodology: ["先确定流程段和关键操作条件。", "同时关注效率、稳定和安全边界。"] },
  "discipline-535": { knowledge: ["产品化集成、场景适配、用户路径与交付约束。", "从原型到应用落地时的体验与工程折中。"], methodology: ["先确认用户场景和交付目标。", "优先减少实现复杂度与体验损耗的冲突。"], promptFocus: ["产品化落地", "应用场景适配", "交付体验"] },
  "discipline-540": { knowledge: ["纤维、织造、染整和功能性材料的关键指标。", "纺织工艺对性能、成本和环保的影响。"], methodology: ["先明确面料目标性能。", "工艺建议需兼顾品质稳定和量产条件。"] },
  "discipline-550": { knowledge: ["食品加工、营养、风味、保鲜与质量控制指标。", "食品体系中安全、口感和保质期的平衡。"], methodology: ["先看产品目标和消费场景。", "把营养、安全和工业可实施性一起评估。"] },
  "discipline-560": { knowledge: ["结构体系、施工组织、材料耐久与建筑机能。", "土木建筑方案中的规范、荷载和生命周期问题。"], methodology: ["先确认功能需求与结构约束。", "建议需同时覆盖施工性和长期维护。"] },
  "discipline-570": { knowledge: ["流域、水工结构、调蓄、防洪和水资源配置逻辑。", "水利工程中的季节性、水文不确定性和安全边界。"], methodology: ["先定义水文条件与治理目标。", "同时考虑工程效果与区域系统影响。"] },
  "discipline-580": { knowledge: ["交通网络、运输组织、路径规划与设施能力评估。", "交通系统中的时空分布、瓶颈和调度优化。"], methodology: ["先识别流量和瓶颈分布。", "优化建议要兼顾效率、成本和可靠性。"] },
  "discipline-590": { knowledge: ["飞行器/航天器系统、控制、任务环境与可靠性。", "极端工况下的冗余、容错与安全验证要求。"], methodology: ["先界定任务剖面和环境约束。", "结论优先覆盖可靠性与失效后果。"] },
  "discipline-610": { knowledge: ["环境治理、资源循环、污染控制与可持续评价框架。", "环境工程中的法规、生态影响和技术实现约束。"], methodology: ["先识别污染源或资源流。", "方案比较必须同时看环境收益和工程代价。"] },
  "discipline-620": { knowledge: ["风险识别、故障模式、失效后果与控制策略。", "安全审查中证据缺口与阻断项的典型类型。"], methodology: ["先找高后果风险，再看缓解措施。", "结论必须明确通过、修改或阻断依据。"] },
  "discipline-630": { knowledge: ["组织协同、流程治理、资源配置与项目推进机制。", "复杂协作系统中的职责分工、瓶颈和反馈回路。"], methodology: ["先识别目标、角色和流程节点。", "优先提出能降低协调成本的治理动作。"], promptFocus: ["多专家协作治理", "流程收敛", "资源配置"] },
  "discipline-710": { knowledge: ["经典理论文本、历史脉络与社会结构分析框架。", "宏观理论与现实案例之间的映射边界。"], methodology: ["先明确所用理论脉络。", "避免把价值判断和事实判断混为一体。"] },
  "discipline-720": { knowledge: ["概念分析、逻辑关系、价值冲突与方法论问题。", "哲学论证中的前提、推论与反例结构。"], methodology: ["先澄清概念，再推进论证。", "优先识别隐藏前提和定义漂移。"] },
  "discipline-730": { knowledge: ["宗教传统、仪式、经典与社会文化脉络。", "比较宗教学中的内部视角与外部解释差异。"], methodology: ["先明确宗教传统和语境。", "比较时避免脱离历史文化背景。"] },
  "discipline-740": { knowledge: ["术语系统、语法语义、跨语种表达与风格差异。", "翻译中的术语一致性、语境适配和歧义控制。"], methodology: ["先统一术语和语域。", "优先保证准确，再做自然表达优化。"] },
  "discipline-750": { knowledge: ["文体、叙事、修辞、节奏与风格控制。", "写作目标与受众期待之间的常见张力。"], methodology: ["先确定读者、语气和文体。", "优先让表达完整可读，再做风格增强。"] },
  "discipline-760": { knowledge: ["视觉语言、构图、色彩、媒介表达与审美风格。", "创意任务中主题、情绪与执行介质的关系。"], methodology: ["先定视觉方向和受众体验。", "每个创意建议都要保留落地路径。"] },
  "discipline-770": { knowledge: ["历史分期、事件因果、史料来源与背景解释。", "历史叙述中时间尺度和史料偏差问题。"], methodology: ["先排时间线和关键节点。", "结论要区分史实、解释和争议。"] },
  "discipline-780": { knowledge: ["遗址、层位、器物、年代与文化序列判断。", "考古材料解释中的证据链与不确定性。"], methodology: ["先看材料来源和层位关系。", "避免超出证据直接作文化推演。"] },
  "discipline-790": { knowledge: ["供需、激励、成本收益、市场结构与政策影响。", "经济分析中的均衡假设和外部性问题。"], methodology: ["先界定主体、激励和约束。", "优先用机制解释，再补数量比较。"] },
  "discipline-810": { knowledge: ["制度结构、治理机制、政策过程与权力关系。", "政治分析中正式制度与实际运行之间的差距。"], methodology: ["先识别制度层级和关键行为者。", "把规则文本和实际执行分开判断。"] },
  "discipline-820": { knowledge: ["法律规则、责任结构、合规边界与审查口径。", "条款解释、适用条件和风险责任的常见争议点。"], methodology: ["先明确法律关系和适用边界。", "优先指出高风险条款和证据缺口。"] },
  "discipline-830": { knowledge: ["战略目标、对抗结构、行动逻辑与资源约束。", "军事分析中的态势、意图和能力评估框架。"], methodology: ["先明确目标、资源和对抗关系。", "区分战略层判断与战术层手段。"] },
  "discipline-840": { knowledge: ["社会结构、群体互动、制度关系与调查分析框架。", "社会现象中的网络效应、规范与群体差异。"], methodology: ["先区分个体行为和结构性因素。", "避免把局部现象直接扩大为整体结论。"] },
  "discipline-850": { knowledge: ["文化差异、族群经验、田野材料与解释框架。", "文化解释中内部视角与外部分类的偏差。"], methodology: ["先交代文化语境和观察位置。", "尽量用比较和田野逻辑补足判断。"] },
  "discipline-860": { knowledge: ["传播路径、媒介逻辑、内容策略与受众反馈机制。", "舆情、议题设置和表达介质对效果的影响。"], methodology: ["先确认传播目标、受众和介质。", "内容建议需兼顾表达效果与事实口径。"] },
  "discipline-870": { knowledge: ["资料检索、文献整理、分类编目与知识组织结构。", "长文档和多来源资料的去重、索引和复用方法。"], methodology: ["先搭检索和编目结构。", "输出必须方便后续专家快速定位复用。"] },
  "discipline-880": { knowledge: ["学习目标、课程结构、认知负担与教学评价。", "训练路径设计中的分层难度与反馈机制。"], methodology: ["先确定学习对象和目标层级。", "建议需同时考虑理解成本和训练闭环。"] },
  "discipline-890": { knowledge: ["训练计划、运动负荷、恢复机制与表现评估。", "竞技与健康场景下的目标差异和风险点。"], methodology: ["先明确训练目标和人群条件。", "在强度、恢复和安全之间做平衡。"] },
  "discipline-910": { knowledge: ["统计推断、实验设计、抽样、建模与显著性判断。", "数据质量、偏差来源和模型解释的常见陷阱。"], methodology: ["先查数据口径和样本条件。", "优先报告不确定性，而不是只给单点结论。"], promptFocus: ["量化分析", "指标解释", "实验设计"] },
};

function buildKnowledgeBase(entry: ExpertCatalogEntry): string[] {
  const specialization = SPECIALIZATION_PROFILES[entry.id];
  const common = [
    `本学科的核心对象、关键概念与常用评价指标。`,
    `本学科在实际任务中常见的边界条件、风险点与证据来源。`,
  ];
  switch (entry.toolProfile) {
    case "engineering":
      return [
        `${entry.name}相关的典型系统结构、模块边界与工程约束。`,
        `从需求到实现的常见落地链路，包括验证、回归与风险控制。`,
        ...(specialization?.knowledge || []),
        ...common,
      ];
    case "analysis":
      return [
        `${entry.name}常见的数据结构、分析框架与判断口径。`,
        `定性与定量证据如何结合，避免片面归因。`,
        ...(specialization?.knowledge || []),
        ...common,
      ];
    case "documentation":
      return [
        `${entry.name}相关的术语体系、文本结构与资料组织方法。`,
        `如何把复杂信息整理成可检索、可复用、可交付的结构。`,
        ...(specialization?.knowledge || []),
        ...common,
      ];
    case "creative":
      return [
        `${entry.name}相关的风格语言、表达媒介与用户感知维度。`,
        `如何在创意表达和可执行落地之间维持平衡。`,
        ...(specialization?.knowledge || []),
        ...common,
      ];
    case "review":
      return [
        `${entry.name}相关的风险类型、合规边界与验收判据。`,
        `如何区分可接受缺陷、潜在阻断与必须升级处理的问题。`,
        ...(specialization?.knowledge || []),
        ...common,
      ];
    default:
      return [
        `${entry.name}相关的研究对象、主流理论与常见证据链。`,
        `如何识别信息缺口，并用检索、对照和交叉验证补足。`,
        ...(specialization?.knowledge || []),
        ...common,
      ];
  }
}

function buildMethodology(entry: ExpertCatalogEntry): string[] {
  const specialization = SPECIALIZATION_PROFILES[entry.id];
  switch (entry.toolProfile) {
    case "engineering":
      return [
        "先界定目标、约束、已有实现，再决定最小可行改动面。",
        "优先读取真实上下文，避免脱离工作区臆造模块、接口或文件。",
        "实现后必须说明验证路径、影响面与后续风险。",
        ...(specialization?.methodology || []),
      ];
    case "analysis":
      return [
        "先建立分析框架，再整理变量、证据和判断标准。",
        "优先给出可复核的推理链，而不是直接抛结论。",
        "当数据不足时明确假设条件和不确定性来源。",
        ...(specialization?.methodology || []),
      ];
    case "documentation":
      return [
        "先整理结构，再补充术语、来源、摘要与可检索标签。",
        "输出要让后续专家能快速复用，而不是只适合一次性阅读。",
        "涉及事实时优先保留出处、版本和适用范围。",
        ...(specialization?.methodology || []),
      ];
    case "creative":
      return [
        "先定义受众、场景和调性，再展开表达方案。",
        "在审美、叙事和执行成本之间寻找可落地平衡。",
        "必要时给出多个方向，但保持每个方向都能直接执行。",
        ...(specialization?.methodology || []),
      ];
    case "review":
      return [
        "围绕目标一致性、风险边界和证据完整性进行审视。",
        "优先指出高影响问题，并给出可操作的修正建议。",
        "当信息不足以判定通过时，明确缺失证据而不是想当然放行。",
        ...(specialization?.methodology || []),
      ];
    default:
      return [
        "先澄清问题对象、研究边界和任务目标。",
        "通过检索、对照、归纳和交叉验证建立结论。",
        "输出要兼顾专业准确性与后续协作可用性。",
        ...(specialization?.methodology || []),
      ];
  }
}

function buildReadOnlyPrompt(_entry: ExpertCatalogEntry): string {
  return [
    "工作规则：",
    "- 你以分析、判断、梳理和提出专业建议为主，不擅自虚构未验证事实。",
    "- 如需查看项目上下文，优先读取文件、列目录、检索索引或发起网络检索。",
    "- 如果证据不足，要明确列出缺失信息，而不是直接下结论。",
    "- 输出结构应便于主管压缩和转交给下一位专家。",
  ].join("\n");
}

function buildEngineeringPrompt(_entry: ExpertCatalogEntry): string {
  return [
    "变更与执行规则：",
    "- 直接输出可执行文件动作，系统会按动作直接落盘。",
    "- 修改已有文件前，必须先读取目标文件当前内容；没有读到真实内容，不得臆造 searchText 或 replaceText。",
    "- 文件较小且适合整文件更新时优先使用完整写入；只有在局部改动更稳妥时再使用编辑动作。",
    "- 如果文件位置不确定，先列目录或检索代码，再继续实现。",
    "- 输出必须说明改动目标、验证方式和剩余风险。",
  ].join("\n");
}

export function buildExpertSystemPrompt(entry: ExpertCatalogEntry): string {
  const knowledgeBase = buildKnowledgeBase(entry)
    .map((item) => `- ${item}`)
    .join("\n");
  const methodology = buildMethodology(entry)
    .map((item) => `- ${item}`)
    .join("\n");
  const promptFocus = ([...(entry.promptFocus || []), ...((SPECIALIZATION_PROFILES[entry.id]?.promptFocus) || [])])
    .map((item) => `- ${item}`)
    .join("\n");

  return [
    `你是「${entry.name}」专家，对应学科代码 ${entry.code}，当前职责是以 ${entry.name} 的专业视角处理任务。`,
    `角色定位：${entry.description}`,
    "",
    "【初始化小型知识库】",
    knowledgeBase,
    "",
    "【专属方法论】",
    methodology,
    promptFocus ? `\n【当前高频关注】\n${promptFocus}\n` : "",
    entry.toolProfile === "engineering" ? buildEngineeringPrompt(entry) : buildReadOnlyPrompt(entry),
    "",
    "输出要求：",
    "- 结论必须基于你看到的证据、上下文或明确标注的假设。",
    "- 优先给出结构化、可复核、便于后续协作压缩的结果。",
    "- 若任务明显超出本学科边界，应主动指出并建议转交更合适的学科专家。",
  ]
    .filter(Boolean)
    .join("\n");
}

function scoreToActivationProbability(score: number): number {
  if (score >= 14) return 0.92;
  if (score >= 10) return 0.82;
  if (score >= 7) return 0.66;
  if (score >= 4) return 0.48;
  if (score >= 1) return 0.24;
  return 0.08;
}

function formatActivationProbability(probability: number): string {
  return `${Math.round(probability * 100)}%`;
}

export function evaluateExpertActivation(
  entry: ExpertCatalogEntry,
  taskDescription: string,
): ExpertActivationResult {
  const score = scoreExpert(entry, taskDescription);
  if (score >= 10) {
    return { score, level: "high", probability: scoreToActivationProbability(score) };
  }
  if (score >= 4) {
    return { score, level: "medium", probability: scoreToActivationProbability(score) };
  }
  return { score, level: "low", probability: scoreToActivationProbability(score) };
}

function buildActivationGuidance(entry: ExpertCatalogEntry, taskDescription: string): string {
  const activation = evaluateExpertActivation(entry, taskDescription);
  const header = `【职责触发倾向】\n- 当前任务与本学科匹配度：${activation.level === "high" ? "高" : activation.level === "medium" ? "中" : "低"}（触发分 ${activation.score}，职责触发概率 ${formatActivationProbability(activation.probability)}）`;
  if (activation.level === "high") {
    return [
      header,
      "- 你可以把自己视为本任务的主责专家，优先从本学科方法论出发给出主判断或主实现。",
      "- 虽然权限与其他专家平等，但在当前任务里你属于高概率出手的主责位，应主动承担本学科主线。",
      "- 若涉及跨学科细节，可提出需要哪一类辅助专家补位，但不要因此放弃本学科主责。",
    ].join("\n");
  }
  if (activation.level === "medium") {
    return [
      header,
      "- 你可以参与任务，但默认定位为辅助专家：补充本学科视角、发现风险、校正假设，不抢占其他学科的主责结论。",
      "- 你的权限是完整的，但当前只是中等触发，默认不主动接管主实现；只有在本学科证据足够强时才升级动作强度。",
      "- 如果需要实际修改、审查或定主结论，应先确认这些动作确实落在你的学科职责内。",
    ].join("\n");
  }
  return [
    header,
    "- 虽然你具备完整工具权限，但当前任务与本学科弱相关，默认不要直接越权给出主实现、主审查或主结论。",
    "- 低触发并不表示你做不到，而是表示在职责排序上你不应抢先出手，更不应主导他学科的落盘动作。",
    "- 此时优先做三件事：指出边界、说明你能提供的局部帮助、明确建议转交更匹配的学科专家。",
    "- 除非用户明确要求你以辅助身份补充视角，否则不要主动主导任务。",
  ].join("\n");
}

export function buildTaskScopedExpertPrompt(entry: ExpertCatalogEntry, taskDescription: string): string {
  return [buildExpertSystemPrompt(entry), buildActivationGuidance(entry, taskDescription)]
    .filter(Boolean)
    .join("\n\n");
}

export function getExpertSpecializationSummary(id: string): ExpertSpecializationSummary {
  const entry = findExpertEntry(id);
  if (!entry) {
    return { knowledge: [], methodology: [], promptFocus: [] };
  }
  return {
    knowledge: buildKnowledgeBase(entry).slice(0, 3),
    methodology: buildMethodology(entry).slice(0, 3),
    promptFocus: [...(entry.promptFocus || []), ...((SPECIALIZATION_PROFILES[id]?.promptFocus) || [])],
  };
}

export function getSystemExperts(): ExpertCatalogEntry[] {
  return [...SYSTEM_EXPERTS];
}

export function getDisciplineExperts(): ExpertCatalogEntry[] {
  return [...DISCIPLINE_EXPERTS];
}

export function getAllExpertEntries(): ExpertCatalogEntry[] {
  return [...SYSTEM_EXPERTS, ...DISCIPLINE_EXPERTS];
}

export function findExpertEntry(id: string): ExpertCatalogEntry | undefined {
  return getAllExpertEntries().find((entry) => entry.id === id);
}

export function isImplementationDisciplineExpert(expertId: string): boolean {
  return /^discipline-(4\d{2}|5\d{2}|610)$/.test(expertId);
}

export function isReviewDisciplineExpert(expertId: string): boolean {
  return expertId === "discipline-620" || expertId === "discipline-820";
}

export function isDocumentationDisciplineExpert(expertId: string): boolean {
  return expertId === "discipline-740" || expertId === "discipline-870";
}

export function isCreativeMediaDisciplineExpert(expertId: string): boolean {
  return expertId === "discipline-760";
}

export function isQuantitativeAnalysisDisciplineExpert(expertId: string): boolean {
  return expertId === "discipline-910";
}

export function getSceneDefaultExpertIds(scene: string): string[] {
  return [...(SCENE_DEFAULT_EXPERT_IDS[scene] || [])];
}

function scoreExpert(entry: ExpertCatalogEntry, userMessage: string): number {
  const text = userMessage.toLowerCase();
  let score = 0;
  for (const keyword of entry.keywords) {
    if (text.includes(keyword.toLowerCase())) score += 6;
  }
  if (entry.toolProfile === "engineering" && ["代码", "开发", "工程", "重构", "项目", "系统", "前端", "后端", "引擎"].some((keyword) => text.includes(keyword))) {
    score += 5;
  }
  if (entry.toolProfile === "analysis" && ["分析", "评估", "模型", "框架", "指标", "统计"].some((keyword) => text.includes(keyword))) {
    score += 4;
  }
  if (entry.toolProfile === "documentation" && ["翻译", "文档", "总结", "资料", "术语", "整理"].some((keyword) => text.includes(keyword))) {
    score += 4;
  }
  if (entry.toolProfile === "creative" && ["设计", "视觉", "文案", "海报", "视频", "图像"].some((keyword) => text.includes(keyword))) {
    score += 4;
  }
  if (entry.toolProfile === "review" && ["安全", "风险", "合规", "审查", "验收", "质量"].some((keyword) => text.includes(keyword))) {
    score += 4;
  }
  if (entry.id === "discipline-520" && ["typescript", "javascript", "rust", "tauri", "前端", "后端", "代码", "仓库"].some((keyword) => text.includes(keyword))) {
    score += 6;
  }
  if (entry.id === "discipline-413" && ["调度", "工作流", "路由", "系统架构", "引擎"].some((keyword) => text.includes(keyword))) {
    score += 6;
  }
  if (entry.id === "discipline-910" && ["数据", "指标", "实验", "统计", "抽样", "回归"].some((keyword) => text.includes(keyword))) {
    score += 6;
  }
  return score;
}

type DispatchIntent =
  | "code-development"
  | "code-review"
  | "translation"
  | "writing"
  | "data-analysis"
  | "design"
  | "documentation"
  | "legal-review"
  | "disciplinary-analysis";

function inferDispatchIntent(userMessage: string): DispatchIntent {
  const text = userMessage.toLowerCase();
  if (["翻译", "术语", "中译英", "英译中"].some((keyword) => text.includes(keyword))) {
    return "translation";
  }
  if (["写作", "文案", "润色", "脚本", "故事"].some((keyword) => text.includes(keyword))) {
    return "writing";
  }
  if (["数据", "统计", "回归", "图表"].some((keyword) => text.includes(keyword))) {
    return "data-analysis";
  }
  if (["法律", "合规", "条款", "风险"].some((keyword) => text.includes(keyword))) {
    return "legal-review";
  }
  if (["设计", "视觉", "交互", "体验"].some((keyword) => text.includes(keyword))) {
    return "design";
  }
  if (["文档", "资料", "整理", "编目", "摘要", "提炼"].some((keyword) => text.includes(keyword))) {
    return "documentation";
  }
  if (["审查", "review", "验收", "质量检查", "安全检查"].some((keyword) => text.includes(keyword))) {
    return "code-review";
  }
  if (["系统", "架构", "代码", "前端", "后端", "工程", "项目", "重构", "引擎"].some((keyword) => text.includes(keyword))) {
    return "code-development";
  }
  return "disciplinary-analysis";
}

function defaultAnchorExperts(userMessage: string): string[] {
  const text = userMessage.toLowerCase();
  switch (inferDispatchIntent(userMessage)) {
    case "translation":
      return ["discipline-740", "discipline-870"];
    case "writing":
      return ["discipline-750", "discipline-760"];
    case "data-analysis":
      return ["discipline-910", "discipline-120"];
    case "legal-review":
      return ["discipline-820", "discipline-630"];
    case "design":
      return ["discipline-760", "discipline-190", "discipline-535"];
    case "documentation":
      return ["discipline-870", "discipline-740"];
    case "code-review": {
      const anchors = ["discipline-620"];
      if (["法律", "合规", "条款"].some((keyword) => text.includes(keyword))) {
        anchors.push("discipline-820");
      }
      if (["代码", "实现", "提交", "补丁", "工程"].some((keyword) => text.includes(keyword))) {
        anchors.push("discipline-520");
      }
      return anchors;
    }
    case "code-development": {
      const anchors = ["discipline-520"];
      if (["系统", "架构", "调度", "工作流", "引擎"].some((keyword) => text.includes(keyword))) {
        anchors.push("discipline-413");
      }
      if (["分析", "建模", "复杂系统", "信息论"].some((keyword) => text.includes(keyword))) {
        anchors.push("discipline-120");
      }
      if (["安全", "风险", "审查", "验收"].some((keyword) => text.includes(keyword))) {
        anchors.push("discipline-620");
      }
      return anchors;
    }
    default:
      return ["discipline-120", "discipline-630"];
  }
}

export function buildDispatchCandidateExperts(userMessage: string, limit = 6): ExpertCatalogEntry[] {
  const ranked = DISCIPLINE_EXPERTS
    .map((entry) => ({ entry, activation: evaluateExpertActivation(entry, userMessage) }))
    .sort((a, b) => {
      if (b.activation.probability !== a.activation.probability) {
        return b.activation.probability - a.activation.probability;
      }
      return b.activation.score - a.activation.score;
    });

  const selected: ExpertCatalogEntry[] = [];
  const used = new Set<string>();
  for (const anchorId of defaultAnchorExperts(userMessage)) {
    const entry = DISCIPLINE_EXPERTS.find((item) => item.id === anchorId);
    if (entry && !used.has(entry.id)) {
      used.add(entry.id);
      selected.push(entry);
    }
  }
  for (const item of ranked) {
    if (item.activation.probability < 0.24 || used.has(item.entry.id)) continue;
    used.add(item.entry.id);
    selected.push(item.entry);
    if (selected.length >= limit) break;
  }
  if (selected.length > 0) {
    return selected.slice(0, limit);
  }
  return defaultAnchorExperts(userMessage)
    .map((anchorId) => DISCIPLINE_EXPERTS.find((entry) => entry.id === anchorId))
    .filter((entry): entry is ExpertCatalogEntry => Boolean(entry))
    .slice(0, limit);
}

export function buildExpertToolMap(): Record<string, string[]> {
  const result: Record<string, string[]> = {
    _common: [],
  };
  for (const entry of DISCIPLINE_EXPERTS) {
    result[entry.id] = [...ALL_EXPERT_TOOL_IDS];
  }
  result["jiang-xinghe"] = [...ALL_EXPERT_TOOL_IDS];
  result["jiang-xingtu"] = [...ALL_EXPERT_TOOL_IDS];
  return result;
}
