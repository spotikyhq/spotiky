// Spotiky Worker. Runs on Cloudflare Workers, not GitHub Pages.
// Live at https://spotiky-preview.spotikyhq.workers.dev
//
//   GET  /?id=TRACK_ID     a track's preview MP3 and song name: { preview_url, name, source }
//   GET  /codes?c=夜光,𓇰𓇶   what each Spotiky code stands for: { "夜光": {type, id, ...}, "𓇰𓇶": null }
//   POST /suggest          { type: "track", id } or { type: "playlist", items } -> code suggestions
//   POST /claim            the same, plus { zh: {code, chars, why}, eg: {code, why} } -> saves the codes
//
// Bindings (Worker -> Settings -> Bindings):
//   CODES  a KV namespace that stores the codes
//   AI     Workers AI, which suggests codes from what a song is about
//
// Previews: Spotify's Web API now returns preview_url: null, so this loads the
// public embed page (open.spotify.com/embed/track/ID) and pulls the preview MP3
// link out of its HTML.
//
// Codes: a song or playlist gets one Chinese code (2-3 common Simplified characters)
// and one hieroglyph code (2-3 signs from the Spotiky set of 98). The first codes
// saved for a song are its codes for good, so the same song always gets the same
// codes. KV keys:
//   <code>           {type: "track", id} or {type: "playlist", items}, plus meanings
//   track:<id>       {zh, eg} for a song
//   list:<hash>      {zh, eg} for a playlist
//   shape:<code>     a Chinese code with look-alike characters, so 白光 blocks 自光

const MODEL = "@cf/qwen/qwen3-30b-a3b-fp8";
const WORDS_URL = "https://raw.githubusercontent.com/spotikyhq/spotiky/main/data/zh-words.json";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
const CODE_RE = /^[\p{Script=Han}\p{Script=Egyptian_Hieroglyphs}]{1,6}$/u;
const ID_RE = /^[a-zA-Z0-9]{22}$/;
const ITEM_RE = /^(?:[a-zA-Z0-9]{22}(?:\$\d+(?:-\d+)?)?|[\p{Script=Han}\p{Script=Egyptian_Hieroglyphs}]{1,6}(?:\d+(?:-\d+)?)?)$/u;

// ---- Character data (generated from the Spotiky glyph review and China's 2013 character table) ----
const GLYPHS = [
  {"c": "𓀁", "name": "speaker", "meaning": "speak, sing, eat, think, feel"},
  {"c": "𓀗", "name": "elder", "meaning": "old, elder, age"},
  {"c": "𓀠", "name": "arms up", "meaning": "high, joy, grief"},
  {"c": "𓀤", "name": "dancer", "meaning": "dance, joy"},
  {"c": "𓁀", "name": "mummy bed", "meaning": "sleep, night, rest"},
  {"c": "𓁥", "name": "hathor", "meaning": "love, music, dance, joy, woman"},
  {"c": "𓁨", "name": "heh", "meaning": "millions, forever, infinity"},
  {"c": "𓁷", "name": "face", "meaning": "face, upon"},
  {"c": "𓁸", "name": "hair", "meaning": "hair, grief, mourning"},
  {"c": "𓁹", "name": "eye", "meaning": "eye, see"},
  {"c": "𓁿", "name": "tears", "meaning": "weep, tears, sorrow"},
  {"c": "𓂀", "name": "horus eye", "meaning": "protection, healing, wholeness"},
  {"c": "𓂋", "name": "mouth", "meaning": "mouth, speech, words"},
  {"c": "𓂓", "name": "ka", "meaning": "soul, spirit, life force"},
  {"c": "𓂘", "name": "embrace", "meaning": "embrace, hug, hold close"},
  {"c": "𓂚", "name": "fighter arms", "meaning": "fight, battle"},
  {"c": "𓂞", "name": "giving arm", "meaning": "give"},
  {"c": "𓂧", "name": "hand", "meaning": "hand"},
  {"c": "𓂻", "name": "legs", "meaning": "walk, go, come, move"},
  {"c": "𓃀", "name": "foot", "meaning": "foot, place"},
  {"c": "𓃒", "name": "bull", "meaning": "bull, strength"},
  {"c": "𓃗", "name": "horse", "meaning": "horse, ride, run, freedom"},
  {"c": "𓃠", "name": "cat", "meaning": "cat, playful, curious"},
  {"c": "𓃡", "name": "dog", "meaning": "dog, loyalty"},
  {"c": "𓃬", "name": "lion", "meaning": "lion, courage"},
  {"c": "𓃯", "name": "hippo", "meaning": "hippo, mighty"},
  {"c": "𓃰", "name": "elephant", "meaning": "elephant, memory"},
  {"c": "𓃱", "name": "giraffe", "meaning": "giraffe, foresee, future"},
  {"c": "𓃹", "name": "hare", "meaning": "hare, to be, exist"},
  {"c": "𓄔", "name": "ear", "meaning": "ear, hear, listen"},
  {"c": "𓄟", "name": "fox skins", "meaning": "born, birth"},
  {"c": "𓄣", "name": "heart", "meaning": "heart, mind, feelings"},
  {"c": "𓄤", "name": "nefer", "meaning": "good, beautiful, perfect"},
  {"c": "𓅃", "name": "falcon", "meaning": "Horus, the sky, the king"},
  {"c": "𓅜", "name": "crested ibis", "meaning": "spirit, glory, shining"},
  {"c": "𓅨", "name": "swallow", "meaning": "great, freedom, return"},
  {"c": "𓅭", "name": "duck", "meaning": "son, child"},
  {"c": "𓅮", "name": "flying goose", "meaning": "fly, flight, escape"},
  {"c": "𓅱", "name": "chick", "meaning": "chick, little, new"},
  {"c": "𓅽", "name": "ba bird", "meaning": "soul"},
  {"c": "𓆃", "name": "wing", "meaning": "wing, fly"},
  {"c": "𓆄", "name": "feather", "meaning": "truth, feather, lightness"},
  {"c": "𓆇", "name": "egg", "meaning": "egg, birth, beginning"},
  {"c": "𓆊", "name": "crocodile", "meaning": "crocodile, fury"},
  {"c": "𓆏", "name": "frog", "meaning": "frog, rebirth"},
  {"c": "𓆙", "name": "snake", "meaning": "snake, winding, temptation"},
  {"c": "𓆛", "name": "fish", "meaning": "fish, swim"},
  {"c": "𓆣", "name": "scarab", "meaning": "become, transform, rebirth, sunrise"},
  {"c": "𓆤", "name": "bee", "meaning": "bee, honey, busy"},
  {"c": "𓆧", "name": "locust", "meaning": "locust, swarm"},
  {"c": "𓆭", "name": "tree", "meaning": "tree, growth, roots"},
  {"c": "𓆳", "name": "palm branch", "meaning": "year, time"},
  {"c": "𓆸", "name": "lotus", "meaning": "lotus, beauty, rebirth"},
  {"c": "𓇇", "name": "papyrus clump", "meaning": "marsh, delta"},
  {"c": "𓇏", "name": "reed field", "meaning": "field, marsh, paradise"},
  {"c": "𓇛", "name": "pod", "meaning": "sweet, pleasant"},
  {"c": "𓇭", "name": "vine", "meaning": "vine, wine, garden"},
  {"c": "𓇯", "name": "sky", "meaning": "sky, heaven"},
  {"c": "𓇰", "name": "night", "meaning": "night, darkness"},
  {"c": "𓇲", "name": "rain", "meaning": "rain, storm"},
  {"c": "𓇳", "name": "sun", "meaning": "sun, day"},
  {"c": "𓇶", "name": "sunshine", "meaning": "light, shine"},
  {"c": "𓇹", "name": "moon", "meaning": "moon, month"},
  {"c": "𓇼", "name": "star", "meaning": "star, hour"},
  {"c": "𓈉", "name": "hills", "meaning": "far away, foreign land, desert"},
  {"c": "𓈌", "name": "horizon", "meaning": "horizon, sunrise, sunset"},
  {"c": "𓈐", "name": "road", "meaning": "road, path, way"},
  {"c": "𓈗", "name": "water", "meaning": "water, flood"},
  {"c": "𓉐", "name": "house", "meaning": "house, home"},
  {"c": "𓉥", "name": "palace", "meaning": "palace"},
  {"c": "𓉴", "name": "pyramid", "meaning": "pyramid, tomb, legacy"},
  {"c": "𓉶", "name": "obelisk", "meaning": "monument, standing tall"},
  {"c": "𓊖", "name": "city", "meaning": "city, town"},
  {"c": "𓊛", "name": "boat", "meaning": "boat, travel, sail"},
  {"c": "𓊡", "name": "sail", "meaning": "wind, breath, air"},
  {"c": "𓊤", "name": "oar", "meaning": "voice"},
  {"c": "𓊨", "name": "throne", "meaning": "throne, seat"},
  {"c": "𓊭", "name": "coffin", "meaning": "burial, coffin"},
  {"c": "𓊮", "name": "fire", "meaning": "fire, flame, heat"},
  {"c": "𓊵", "name": "hotep", "meaning": "peace, rest, content"},
  {"c": "𓊽", "name": "djed", "meaning": "stability, endure"},
  {"c": "𓋖", "name": "double crown", "meaning": "crown, ruler, unite"},
  {"c": "𓋞", "name": "gold", "meaning": "gold, golden"},
  {"c": "𓋭", "name": "knot", "meaning": "knot, tie, bind"},
  {"c": "𓋹", "name": "ankh", "meaning": "life, live"},
  {"c": "𓋺", "name": "sunshade", "meaning": "shade, shadow"},
  {"c": "𓌕", "name": "arrow", "meaning": "arrow, shoot"},
  {"c": "𓌤", "name": "net", "meaning": "net, catch"},
  {"c": "𓌪", "name": "knife", "meaning": "knife, cut"},
  {"c": "𓌸", "name": "hoe", "meaning": "love (Egyptians spelled 'love' with a hoe)"},
  {"c": "𓍝", "name": "balance", "meaning": "balance, judge, weigh"},
  {"c": "𓍢", "name": "rope coil", "meaning": "hundred, rope"},
  {"c": "𓍶", "name": "shen", "meaning": "eternity, forever, surround"},
  {"c": "𓎱", "name": "festival", "meaning": "festival, celebration"},
  {"c": "𓏁", "name": "cool jar", "meaning": "cool, refresh"},
  {"c": "𓏞", "name": "scribe kit", "meaning": "write, scribe"},
  {"c": "𓏠", "name": "senet", "meaning": "game, play"},
  {"c": "𓏣", "name": "sistrum", "meaning": "music"},
];
const ZH_POOL = new Set(
  "一乙二十丁厂七卜八人入儿匕几九刁了刀力乃又三干于亏工土士才下寸大丈与万上小口山巾千乞川亿个夕久么勺凡丸及广亡门丫义之己已巳弓子卫也女刃飞习叉马乡丰王开井天夫元无云专丐扎艺木五支厅不犬太区历歹友尤匹车巨"
  + "牙屯戈比互切瓦止少曰日中贝冈内水见午牛手气毛壬升夭长仁什片仆化仇币仍仅斤爪反介父从仑今凶分乏公仓月氏勿欠风丹匀乌勾凤六文亢方火为斗忆计订户认冗讥心尺引丑巴孔队办以允予邓劝双书幻玉刊未末示击打巧正扑卉扒"
  + "功扔去甘世艾古节本术可丙左厉石右布夯戊龙平灭轧东卡北占凸卢业旧帅归旦目且叶甲申叮电号田由只叭史央兄叽叼叫叩叨另叹冉皿凹囚四生矢失乍禾丘付仗代仙们仪白仔他斥瓜乎丛令用甩印尔乐句匆册卯犯外处冬鸟务包饥主市"
  + "立冯玄闪兰半汁汇头汉宁穴它讨写让礼训议必讯记永司尼民弗弘出辽奶奴召加皮边孕发圣对台矛纠母幼丝邦式迂刑戎动扛寺吉扣考托老巩圾执扩扫地场扬耳芋共芒亚芝朽朴机权过臣吏再协西压厌戌在百有存而页匠夸夺灰达列死成"
  + "夹夷轨邪尧划迈毕至此贞师尘尖劣光当早吁吐吓虫曲团吕同吊吃因吸吗吆屿屹岁帆回岂则刚网肉年朱先丢廷舌竹迁乔迄伟传乒乓休伍伏优臼伐延仲件任伤价伦份华仰仿伙伪自伊血向似后行舟全会杀合兆企众爷伞创肌肋朵杂危旬旨"
  + "旭负匈名各多争色壮冲妆冰庄庆亦刘齐交衣次产决亥充妄闭问闯羊并关米灯州汗污江汛池汝汤忙兴宇守宅字安讲讳军讶许讹论讼农讽设访诀寻那迅尽导异弛孙阵阳收阶阴防奸如妇妃好她妈戏羽观欢买红驮纤驯约级纪驰纫巡寿弄麦"
  + "玖玛形进戒吞远违韧运扶抚坛技坏抠扰扼拒找批址扯走抄贡汞坝攻赤折抓扳抡扮抢孝坎均抑抛投坟坑抗坊抖护壳志块扭声把报拟却抒劫芙芜苇芽花芹芥芬苍芳严芦芯劳克芭苏杆杠杜材村杖杏杉巫极李杨求甫匣更束吾豆两酉丽医辰"
  + "励否还尬歼来连轩步卤坚肖旱盯呈时吴助县里呆吱吠呕园旷围呀吨足邮男困吵串员呐听吟吩呛吻吹呜吭吧邑吼囤别吮岖岗帐财针钉牡告我乱利秃秀私每兵估体何佐佑但伸佃作伯伶佣低你住位伴身皂伺佛囱近彻役返余希坐谷妥含邻"
  + "岔肝肛肚肘肠龟甸免狂犹狈角删条彤卵灸岛刨迎饭饮系言冻状亩况床库庇疗吝应这冷庐序辛弃冶忘闰闲间闷判兑灶灿灼弟汪沐沛汰沥沙汽沃沦汹泛沧没沟沪沈沉沁怀忧忱快完宋宏牢究穷灾良证启评补初社祀识诈诉罕诊词译君灵即"
  + "层尾迟局改张忌际陆阿陈阻附坠妙妖姊妨妒努忍劲矣纬驱纯纱纲纳驳纵纷纸纹纺驴纽奉玩环武青责现玫表规抹卦坷坯拓拢拔坪拣坦担坤押抽拐拖者拍顶拆拎拥抵拘势抱拄垃拉拦幸拌拧拂拙招坡披拨择抬拇拗其取茉苦昔苛若茂苹苗"
  + "英苟苑苞范直茁茄茎苔茅枉林枝杯枢柜枚析板松枪枫构杭杰述枕丧或画卧事刺枣雨卖郁矾矿码厕奈奔奇奋态欧殴垄妻轰顷转斩轮软到非叔歧肯齿些卓虎虏肾贤尚旺具味果昆国哎咕昌呵畅明易咙昂迪典固忠呻咒咋咐呼鸣咏呢咄咖岸"
  + "岩帖罗帜帕岭凯败账贩贬购贮图钓制知迭氛垂牧物乖刮秆和季委秉佳侍岳供使例侠侥版侄侦侣侧凭侨佩货侈依卑的迫质欣征往爬彼径所舍金刹命肴斧爸采觅受乳贪念贫忿肤肺肢肿胀朋股肮肪肥服胁周昏鱼兔狐忽狗狞备饰饱饲变京"
  + "享庞店夜庙府底疟疙疚剂卒郊庚废净盲放刻育氓闸闹郑券卷单炬炒炊炕炎炉沫浅法泄沽河沾泪沮油泊沿泡注泣泞泻泌泳泥沸沼波泼泽治怔怯怖性怕怜怪怡学宝宗定宠宜审宙官空帘宛实试郎诗肩房诚衬衫视祈话诞诡询该详建肃录隶"
  + "帚屉居届刷屈弧弥弦承孟陋陌孤陕降函限妹姑姐姓妮始姆迢驾叁参艰线练组绅细驶织驹终驻绊驼绍绎经贯契贰奏春帮玷珍玲珊玻毒型拭挂封持拷拱项垮挎城挟挠政赴赵挡拽哉挺括垢拴拾挑垛指垫挣挤拼挖按挥挪拯某甚荆茸革茬荐"
  + "巷带草茧茵茶荒茫荡荣荤荧故胡荫荔南药标栈柑枯柄栋相查柏栅柳柱柿栏柠树勃要柬咸威歪研砖厘厚砌砂泵砚砍面耐耍牵鸥残殃轴轻鸦皆韭背战点虐临览竖省削尝昧盹是盼眨哇哄哑显冒映星昨咧昭畏趴胃贵界虹虾蚁思蚂虽品咽骂"
  + "勋哗咱响哈哆咬咳咪哪哟炭峡罚贴贻骨幽钙钝钞钟钢钠钥钦钧钩钮卸缸拜看矩毡氢怎牲选适秒香种秋科重复竿段便俩贷顺修俏保促俄俐侮俭俗俘信皇泉鬼侵禹侯追俊盾待徊衍律很须叙剑逃食盆胚胧胆胜胞胖脉胎勉狭狮独狰狡狱狠"
  + "贸怨急饵饶蚀饺饼峦弯将奖哀亭亮度迹庭疮疯疫疤咨姿亲音帝施闺闻闽阀阁差养美姜叛送类迷籽娄前首逆兹总炼炸烁炮炫烂剃洼洁洪洒柒浇浊洞测洗活派洽染洛浏济洋洲浑浓津恃恒恢恍恬恤恰恼恨举觉宣宦室宫宪突穿窃客诫冠诬"
  + "语扁袄祖神祝祠误诱诲说诵垦退既屋昼屏费陡逊眉孩陨除险院娃姥姨姻娇姚娜怒架贺盈勇怠癸蚤柔垒绑绒结绕骄绘给绚骆络绝绞骇统耕耘耗耙艳泰秦珠班素匿蚕顽盏匪捞栽捕埂捂振载赶起盐捎捍捏埋捉捆捐损袁捌都哲逝捡挫换挽"
  + "挚热恐捣壶捅埃挨耻耿耽聂恭莽莱莲莫莉荷获晋恶莹莺真框梆桂桔栖档桐株桥桦栓桃格桩校核样根索哥速逗栗贾酌配翅辱唇夏砸砰砾础破原套逐烈殊殉顾轿较顿毙致柴桌虑监紧党逞晒眠晓哮唠晃哺晌剔晕蚌畔蚣蚊蚪蚓哨哩圃哭哦"
  + "恩鸯唤唁哼唧啊唉唆罢峭峨峰圆峻贼贿赂赃钱钳钻钾铁铃铅缺氧氨特牺造乘敌秤租积秧秩称秘透笔笑笋债借值倚俺倾倒倘俱倡候赁俯倍倦健臭射躬息倔徒徐殷舰舱般航途拿耸爹舀爱豺豹颁颂翁胰脆脂胸胳脏脐胶脑脓逛狸狼卿逢鸵"
  + "留鸳皱饿馁凌凄恋桨浆衰衷高郭席准座症病疾斋疹疼疲脊效离紊唐瓷资凉站剖竞部旁旅畜阅羞羔瓶拳粉料益兼烤烘烦烧烛烟烙递涛浙涝浦酒涉消涡浩海涂浴浮涣涤流润涧涕浪浸涨烫涩涌悖悟悄悍悔悯悦害宽家宵宴宾窍窄容宰案请"
  + "朗诸诺读扇诽袜袖袍被祥课冥谁调冤谅谆谈谊剥恳展剧屑弱陵祟陶陷陪娱娟恕娥娘通能难预桑绢绣验继骏球琐理琉琅捧堵措描域捺掩捷排焉掉捶赦堆推埠掀授捻教掏掐掠掂培接掷控探据掘掺职基聆勘聊娶著菱勒黄菲萌萝菌萎菜萄"
  + "菊菩萍菠萤营乾萧萨菇械彬梦婪梗梧梢梅检梳梯桶梭救曹副票酝酗厢戚硅硕奢盔爽聋袭盛匾雪辅辆颅虚彪雀堂常眶匙晨睁眯眼悬野啪啦曼晦晚啄啡距趾啃跃略蚯蛀蛇唬累鄂唱患啰唾唯啤啥啸崖崎崭逻崔帷崩崇崛婴圈铐铛铝铜铭铲"
  + "银矫甜秸梨犁秽移笨笼笛笙符第敏做袋悠偿偶偎偷您售停偏躯兜假衅徘徙得衔盘舶船舵斜盒鸽敛悉欲彩领脚脖脯豚脸脱象够逸猜猪猎猫凰猖猛祭馅馆凑减毫烹庶麻庵痊痒痕廊康庸鹿盗章竟商族旋望率阎阐着羚盖眷粘粗粒断剪兽焊"
  + "焕清添鸿淋涯淹渠渐淑淌混淮淆渊渔淘淳液淤淡淀深涮涵婆梁渗情惜惭悼惧惕惟惊惦悴惋惨惯寇寅寄寂宿窒窑密谋谍谎谐袱祷祸谓谚谜逮敢尉屠弹隋堕随蛋隅隆隐婚婶婉颇颈绩绪续骑绰绳维绵绷绸综绽绿缀巢琴琳琢琼斑替揍款堪"
  + "塔搭堰揩越趁趋超揽堤提博揭喜彭揣插揪搜煮援搀裁搁搓搂搅壹握搔揉斯期欺联葫散惹葬募葛董葡敬葱蒋蒂落韩朝辜葵棒棱棋椰植森焚椅椒棵棍椎棉棚棕棺榔椭惠惑粟棘酣酥厨厦硬硝确硫雁殖裂雄颊雳暂雅翘辈悲紫凿辉敞棠赏掌"
  + "晴睐暑最晰量鼎喷喳晶喇遇喊遏晾景畴践跋跌跑跛遗蛙蛛蜓蜒蛤喝鹃喂喘喉喻啼喧嵌幅帽赋赌赎赐赔黑铸铺链销锁锄锅锈锋锌锐甥掰短智氮毯氯鹅剩稍程稀税筐等筑策筛筒筏答筋筝傲傅牌堡集焦傍储皓皖粤奥街惩御循艇舒逾番释"
  + "禽腊脾腋腔腕鲁猩猬猾猴惫然馈馋装蛮就敦斌痘痢痪痛童竣阔善翔羡普尊奠道遂曾焰港滞湖湘渣渤渺湿温渴溃溅滑湃渝湾渡游滋渲溉愤慌惰愕愣惶愧愉慨割寒富寓窜窝窖窗窘遍雇裕裤裙禅禄谢谣谤谦犀属屡强粥疏隔隙隘媒絮嫂媚"
  + "婿登缅缆缉缎缓缔缕骗编缘瑟鹉瑞瑰瑙魂肆摄摸填搏塌鼓摆携搬摇搞塘摊聘斟蒜勤靴靶鹊蓝墓幕蓬蓄蒲蓉蒙蒸献椿禁楚楷榄想槐榆楼概赖酪酬感碍碘碑碎碰碗碌尴雷零雾雹辐辑输督频龄鉴睛睹睦瞄睫睡睬嗜鄙嗦愚暖盟歇暗暇照畸"
  + "跨跷跳跺跪路跤跟遣蜈蜗蛾蜂蜕嗅嗡嗓署置罪罩蜀幌错锚锡锣锤锥锦键锯锰矮辞稚稠颓愁筹签简筷毁舅鼠催傻像躲魁衙微愈遥腻腰腥腮腹腺鹏腾腿鲍猿颖触解煞雏馍馏酱禀痹廓痴痰廉靖新韵意誊粮数煎塑慈煤煌满漠滇源滤滥滔溪"
  + "溜漓滚溢溯滨溶溺粱滩慎誉塞寞窥窟寝谨褂裸福谬群殿辟障媳嫉嫌嫁叠缚缝缠缤剿静碧璃赘熬墙墟嘉摧赫截誓境摘摔撇聚慕暮摹蔓蔑蔡蔗蔽蔼熙蔚兢模槛榴榜榨榕歌遭酵酷酿酸碟碱碳磁愿需辖辗雌裳颗瞅墅嗽踊蜻蜡蝇蜘蝉嘛嘀赚"
  + "锹锻镀舞舔稳熏箕算箩管箫舆僚僧鼻魄魅貌膜膊膀鲜疑孵馒裹敲豪膏遮腐瘩瘟瘦辣彰竭端旗精粹歉弊熄熔煽潇漆漱漂漫滴漾演漏慢慷寨赛寡察蜜寥谭肇褐褪谱隧嫩翠熊凳骡缩慧撵撕撒撩趣趟撑撮撬播擒墩撞撤增撰聪鞋鞍蕉蕊蔬蕴"
  + "横槽樱橡樟橄敷豌飘醋醇醉磕磊磅碾震霄霉瞒题暴瞎嘻嘶嘲嘹影踢踏踩踪蝶蝴蝠蝎蝌蝗蝙嘿嘱幢墨镇镐镑靠稽稻黎稿稼箱篓箭篇僵躺僻德艘膝膛鲤鲫熟摩褒瘪瘤瘫凛颜毅糊遵憋潜澎潮潭鲨澳潘澈澜澄懂憔懊憎额翩褥谴鹤憨慰劈履"
  + "豫缭撼擂操擅燕蕾薯薛薇擎薪薄颠翰噩橱橙橘整融瓢醒霍霎辙冀餐嘴踱蹄蹂蟆螃器噪鹦赠默黔镜赞穆篮篡篷篱儒邀衡膨雕鲸磨瘾瘸凝辨辩糙糖糕燃濒澡激懒憾懈窿壁避缰缴戴擦藉鞠藏藐檬檐檀礁磷霜霞瞭瞧瞬瞳瞩瞪曙蹋蹈螺蟋蟀"
  + "嚎赡穗魏簧簇繁徽爵朦臊鳄癌辫赢糟糠燥懦豁臀臂翼骤藕鞭藤覆瞻蹦嚣镰翻鳍鹰瀑襟璧戳孽警蘑藻攀曝蹲蹭蹬巅簸簿蟹颤靡癣瓣羹鳖爆疆鬓壤馨耀躁蠕嚼嚷巍籍鳞魔糯灌譬蠢霸露霹躏黯髓赣囊镶瓤罐矗");
const ZH_SHAPES = {"己": "己", "已": "己", "巳": "己", "未": "未", "末": "未", "土": "土", "士": "土", "日": "日", "曰": "日", "人": "人", "入": "人", "八": "人", "大": "大", "太": "大", "犬": "大", "天": "天", "夫": "天", "夭": "天", "王": "王", "玉": "王", "主": "王", "刀": "刀", "力": "刀", "千": "千", "干": "千", "于": "千", "戊": "戊", "戌": "戊", "戎": "戊", "免": "免", "兔": "免", "鸟": "鸟", "乌": "鸟", "白": "白", "自": "白", "贝": "贝", "见": "贝", "由": "由", "甲": "由", "申": "由", "田": "由", "午": "午", "牛": "午", "今": "今", "令": "今", "折": "折", "拆": "折", "析": "折", "侯": "侯", "候": "侯", "失": "失", "矢": "失", "拔": "拔", "拨": "拔", "辨": "辨", "辩": "辨", "辫": "辨", "壁": "壁", "璧": "壁", "暑": "暑", "署": "暑", "崇": "崇", "祟": "崇", "狠": "狠", "很": "狠", "幻": "幻", "幼": "幻", "洒": "洒", "酒": "洒", "历": "历", "厉": "历", "徒": "徒", "徙": "徒", "弛": "弛", "驰": "弛", "晴": "晴", "睛": "晴", "冶": "冶", "治": "冶"};
const ZH_BLOCK = new Set(["上床", "二奶", "二逼", "他妈", "你妈", "做爱", "傻逼", "六四", "出轨", "分梨", "卧槽", "去死", "台独", "吸毒", "垃圾", "奶子", "妈的", "婊子", "小三", "屁股", "屌丝", "废物", "强奸", "性交", "我操", "找死", "放屁", "杀人", "死人", "毒品", "法轮", "混蛋", "港独", "滚蛋", "牛逼", "狗屎", "王八", "畜生", "疆独", "笨蛋", "绿帽", "自杀", "藏独", "蠢货", "装逼", "该死", "贱人", "送终", "送钟", "骚货", "鸡巴"]);
const GLYPH_BY_CHAR = new Map(GLYPHS.map(g => [g.c, g]));

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    const url = new URL(request.url);
    try {
      if (url.pathname === "/codes") return await codes(url, env);
      if (url.pathname === "/suggest" && request.method === "POST") return await suggest(request, env);
      if (url.pathname === "/claim" && request.method === "POST") return await claim(request, env);
    } catch (err) {
      return json({ error: "Server error", details: String((err && err.message) || err) }, 500);
    }
    return preview(url);
  },
};

// ---- Looking codes up ------------------------------------------------------------

async function codes(url, env) {
  if (!env.CODES) {
    return json({ error: "Codes aren't set up on this Worker yet" }, 503);
  }
  const list = [...new Set((url.searchParams.get("c") || "").split(",").map(c => c.trim()).filter(Boolean))];
  if (!list.length || list.length > 50) {
    return json({ error: "Pass 1 to 50 codes, separated by commas, as ?c=" }, 400);
  }
  const out = {};
  await Promise.all(list.map(async code => {
    out[code] = null;
    if (!CODE_RE.test(code)) return;
    try {
      out[code] = await env.CODES.get(code, "json");
    } catch (err) {
      out[code] = null;   // a value that isn't valid JSON counts as no song
    }
  }));
  return json(out, 200, { "Cache-Control": "public, max-age=60" });
}

// ---- Suggesting codes --------------------------------------------------------------

async function suggest(request, env) {
  if (!env.CODES) return json({ error: "Codes aren't set up on this Worker yet" }, 503);
  const body = await request.json().catch(() => null);
  const target = await parseTarget(body);
  if (!target) return json({ error: "Send a song id or a playlist" }, 400);

  const existing = await existingCodes(env, target);
  if (existing) return json({ existing: true, ...existing });

  if (!env.AI) return json({ error: "Code suggestions aren't set up on this Worker yet" }, 503);
  const songs = await songsFor(target, env);
  if (!songs.length) return json({ error: "Couldn't read this song from Spotify. Try again in a moment." }, 502);

  const words = await loadWords();
  const prompt = buildPrompt(songs, target.type === "playlist");
  let zh = { cands: [], alts: [] }, eg = { cands: [], alts: [] };
  for (let attempt = 0; attempt < 2 && (!zh.cands.length || !eg.cands.length); attempt++) {
    const ai = await askAI(env, prompt);
    if (!zh.cands.length) zh = readChinese(ai, words);
    if (!eg.cands.length) eg = readGlyphs(ai);
  }
  if (!zh.cands.length && !eg.cands.length) {
    return json({ error: "Couldn't come up with codes for this one. Try again." }, 502);
  }
  const [zhPick, egPick] = await Promise.all([
    pickFree(env, "zh", zh, target, words),
    pickFree(env, "eg", eg, target, words),
  ]);
  return json({ existing: false, zh: zhPick, eg: egPick, about: songs.map(songLabel) });
}

const SYSTEM = "You name songs with short, poetic codes for Spotiky, a music link app. You write in your own words, never quote song lyrics, and reply with JSON only.";

function buildPrompt(songs, isPlaylist) {
  const subject = isPlaylist
    ? `a playlist of these songs:\n${songs.map((s, i) => `${i + 1}. ${songLabel(s)}`).join("\n")}`
    : `the song ${songLabel(songs[0])}`;
  const what = isPlaylist ? "playlist" : "song";
  const glyphLines = GLYPHS.map(g => `${g.c} ${g.name}: ${g.meaning}`).join("\n");
  return `Make Spotiky codes for ${subject}

A code is two characters that capture what the ${what} is about: its story, mood or imagery, not just the words in its title. Describe themes in your own words and never quote lyrics.

Chinese: give 3 different codes. Each is 2 common Simplified Chinese characters that read naturally to a Chinese speaker, as a real word or a poetic pair. Avoid slang, rude, unlucky or political readings. Give each character a short English meaning. If the pair is an existing Chinese word, put that word's meaning in "word", otherwise null.

Hieroglyphs: give 3 different codes. Each is 2 signs taken only from this list (sign, name: meaning):
${glyphLines}

For both scripts, also give 4 alternatives for each position of your first code: characters or signs that would also fit in that spot.
Write each "why" as one short English line, under 12 words, about the ${what}.

Reply with JSON only, in exactly this shape:
{"zh":[{"code":"..","chars":[{"char":"..","meaning":".."},{"char":"..","meaning":".."}],"word":null,"why":".."}],
"zh_alts":[[{"char":"..","meaning":".."}],[{"char":"..","meaning":".."}]],
"eg":[{"code":"..","why":".."}],
"eg_alts":[["..",".."],["..",".."]]}
/no_think`;
}

async function askAI(env, prompt) {
  try {
    const res = await env.AI.run(MODEL, {
      messages: [{ role: "system", content: SYSTEM }, { role: "user", content: prompt }],
      max_tokens: 1400,
      temperature: 0.7,
    });
    const out = res && (res.response ?? res.choices?.[0]?.message?.content ?? res.choices?.[0]?.text);
    if (out && typeof out === "object") return out;
    return parseJsonLoose(String(out || ""));
  } catch (err) {
    return null;
  }
}

function parseJsonLoose(text) {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/```(?:json)?/g, "");
  const start = cleaned.indexOf("{"), end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(cleaned.slice(start, end + 1)); } catch (err) { return null; }
}

function readChinese(ai, words) {
  const cands = [];
  for (const c of Array.isArray(ai && ai.zh) ? ai.zh : []) {
    const code = typeof (c && c.code) === "string" ? c.code.trim() : "";
    if (zhProblem(code) || cands.some(x => x.code === code)) continue;
    const given = Array.isArray(c.chars) ? c.chars : [];
    cands.push({
      code,
      chars: [...code].map((ch, i) => ({
        char: ch,
        meaning: text((given[i] && given[i].char === ch ? given[i] : given.find(g => g && g.char === ch) || {}).meaning, 30),
      })),
      word: wordFor(code, words) || text(c.word, 40) || null,   // the dictionary wins over the model
      why: text(c.why, 90),
    });
  }
  const alts = [0, 1].map(i => {
    const list = Array.isArray(ai && ai.zh_alts) && Array.isArray(ai.zh_alts[i]) ? ai.zh_alts[i] : [];
    return list
      .filter(a => a && typeof a.char === "string" && [...a.char].length === 1 && ZH_POOL.has(a.char))
      .map(a => ({ char: a.char, meaning: text(a.meaning, 30) }));
  });
  return { cands, alts };
}

function readGlyphs(ai) {
  const cands = [];
  for (const c of Array.isArray(ai && ai.eg) ? ai.eg : []) {
    const code = typeof (c && c.code) === "string" ? c.code.replace(/\s+/g, "") : "";
    if (egProblem(code) || cands.some(x => x.code === code)) continue;
    cands.push({ code, chars: [...code].map(glyphChar), why: text(c.why, 90) });
  }
  const alts = [0, 1].map(i => {
    const list = Array.isArray(ai && ai.eg_alts) && Array.isArray(ai.eg_alts[i]) ? ai.eg_alts[i] : [];
    return list.map(a => (typeof a === "string" ? a : a && a.char)).filter(a => GLYPH_BY_CHAR.has(a)).map(glyphChar);
  });
  return { cands, alts };
}

function glyphChar(ch) {
  const g = GLYPH_BY_CHAR.get(ch);
  return { char: ch, name: g ? g.name : "", meaning: g ? g.meaning : "" };
}

// The first suggestion nobody else has. If every one is taken, add a third character.
async function pickFree(env, script, built, target, words) {
  if (!built.cands.length) return null;
  for (const c of built.cands) {
    if (await isFree(env, script, c.code, target)) return withOptions(c, built, false);
  }
  const first = built.cands[0];
  for (const extra of built.alts[1] || []) {
    const code = first.code + extra.char;
    if (problem(script, code) || !(await isFree(env, script, code, target))) continue;
    const longer = { ...first, code, chars: [...first.chars, extra] };
    if (script === "zh") longer.word = wordFor(code, words) || null;
    return withOptions(longer, built, false);
  }
  return withOptions(first, built, true);   // all taken: the sharer swaps a character
}

// Dropdown choices for each position: the pick first, then alternatives, then other suggestions' characters
function withOptions(pick, built, taken) {
  const options = pick.chars.map((chosen, i) => {
    const seen = new Set(), list = [];
    for (const o of [chosen, ...(built.alts[i] || []), ...built.cands.map(c => c.chars[i]).filter(Boolean)]) {
      if (!o || seen.has(o.char)) continue;
      seen.add(o.char);
      list.push(o);
    }
    return list.slice(0, 7);
  });
  return { ...pick, options, taken };
}

// ---- Saving codes --------------------------------------------------------------------

async function claim(request, env) {
  if (!env.CODES) return json({ error: "Codes aren't set up on this Worker yet" }, 503);
  const body = await request.json().catch(() => null);
  const target = await parseTarget(body);
  if (!target) return json({ error: "Send a song id or a playlist" }, 400);

  const already = await existingCodes(env, target);
  if (already) return json({ existing: true, ...already });

  const zh = typeof (body.zh && body.zh.code) === "string" ? body.zh.code.trim() : null;
  const eg = typeof (body.eg && body.eg.code) === "string" ? body.eg.code.replace(/\s+/g, "") : null;
  if (!zh && !eg) return json({ error: "Send a Chinese code, a hieroglyph code or both" }, 400);
  for (const [script, code] of [["zh", zh], ["eg", eg]]) {
    if (!code) continue;
    const why = problem(script, code);
    if (why) return json({ error: why, script, code }, 400);
    if (!(await isFree(env, script, code, target))) {
      return json({ error: `${code} already belongs to another ${script === "zh" ? "song or a look-alike code" : "song"}`, script, code, taken: true }, 409);
    }
  }

  const at = new Date().toISOString();
  const base = target.type === "track" ? { type: "track", id: target.id } : { type: "playlist", items: target.items };
  const writes = [];
  let zhOut = null, egOut = null;
  if (zh) {
    const words = await loadWords();
    const given = Array.isArray(body.zh.chars) ? body.zh.chars : [];
    const chars = [...zh].map((ch, i) => ({ char: ch, meaning: text(given[i] && given[i].char === ch ? given[i].meaning : "", 30) }));
    zhOut = { code: zh, chars, word: wordFor(zh, words) || text(body.zh.word, 40) || null, why: text(body.zh.why, 90) };
    writes.push(env.CODES.put(zh, JSON.stringify({ ...base, script: "zh", chars, word: zhOut.word, why: zhOut.why, at })));
    if (hasShapeChar(zh)) writes.push(env.CODES.put(shapeKey(zh), zh));
  }
  if (eg) {
    egOut = { code: eg, chars: [...eg].map(glyphChar), why: text(body.eg.why, 90) };
    writes.push(env.CODES.put(eg, JSON.stringify({ ...base, script: "eg", why: egOut.why, at })));
  }
  writes.push(env.CODES.put(target.key, JSON.stringify({ zh, eg, at })));
  await Promise.all(writes);
  return json({ existing: false, zh: zhOut, eg: egOut });
}

async function existingCodes(env, target) {
  const rec = await env.CODES.get(target.key, "json");
  if (!rec) return null;
  const [zhRec, egRec] = await Promise.all([
    rec.zh ? env.CODES.get(rec.zh, "json") : null,
    rec.eg ? env.CODES.get(rec.eg, "json") : null,
  ]);
  return {
    zh: rec.zh ? {
      code: rec.zh,
      chars: zhRec && Array.isArray(zhRec.chars) ? zhRec.chars : [...rec.zh].map(ch => ({ char: ch, meaning: "" })),
      word: (zhRec && zhRec.word) || null,
      why: (zhRec && zhRec.why) || "",
    } : null,
    eg: rec.eg ? { code: rec.eg, chars: [...rec.eg].map(glyphChar), why: (egRec && egRec.why) || "" } : null,
  };
}

// ---- Rules for codes -------------------------------------------------------------------

function problem(script, code) {
  return script === "zh" ? zhProblem(code) : egProblem(code);
}

function zhProblem(code) {
  const cs = [...String(code || "")];
  if (cs.length < 2 || cs.length > 3) return "A Chinese code needs 2 or 3 characters";
  if (!cs.every(c => ZH_POOL.has(c))) return "Chinese codes use common Simplified characters only";
  for (let i = 0; i + 1 < cs.length; i++) {
    if (ZH_BLOCK.has(cs[i] + cs[i + 1])) return "That code reads as a word Spotiky doesn't use";
  }
  return null;
}

function egProblem(code) {
  const cs = [...String(code || "")];
  if (cs.length < 2 || cs.length > 3) return "A hieroglyph code needs 2 or 3 signs";
  if (!cs.every(c => GLYPH_BY_CHAR.has(c))) return "Hieroglyph codes use signs from the Spotiky set only";
  return null;
}

const hasShapeChar = code => [...code].some(c => ZH_SHAPES[c]);
const shapeKey = code => "shape:" + [...code].map(c => ZH_SHAPES[c] || c).join("");

async function isFree(env, script, code, target) {
  const rec = await env.CODES.get(code, "json");
  if (rec && !sameTarget(rec, target)) return false;
  if (script === "zh" && hasShapeChar(code)) {
    const owner = await env.CODES.get(shapeKey(code));
    if (owner && owner !== code) return false;   // a look-alike of a code that exists
  }
  return true;
}

function sameTarget(rec, target) {
  return rec.type === target.type && (target.type === "track" ? rec.id === target.id : rec.items === target.items);
}

async function parseTarget(body) {
  if (!body || typeof body !== "object") return null;
  if (body.type === "track" && ID_RE.test(body.id || "")) {
    return { type: "track", id: body.id, key: "track:" + body.id };
  }
  if (body.type === "playlist" && typeof body.items === "string") {
    const items = body.items.trim();
    const tokens = items.split(",");
    if (!items || items.length > 4000 || tokens.length > 100 || !tokens.every(t => ITEM_RE.test(t))) return null;
    return { type: "playlist", items, key: "list:" + (await sha256(items)) };
  }
  return null;
}

// ---- Song details ------------------------------------------------------------------------

async function songsFor(target, env) {
  if (target.type === "track") {
    const s = await songInfo(target.id);
    return s ? [s] : [];
  }
  const ids = [];
  for (const token of target.items.split(",")) {
    if (ids.length >= 8) break;
    const id = token.slice(0, 22);
    if (ID_RE.test(id)) { ids.push(id); continue; }
    const code = token.replace(/[\d-]+$/, "");
    const rec = await env.CODES.get(code, "json").catch(() => null);
    if (rec && rec.type === "track" && ID_RE.test(rec.id)) ids.push(rec.id);
  }
  return (await Promise.all(ids.map(songInfo))).filter(Boolean);
}

async function songInfo(id) {
  try {
    const res = await fetch(`https://open.spotify.com/embed/track/${id}`, { headers: { "User-Agent": UA } });
    if (!res.ok) return null;
    const html = await res.text();
    let title = null, artist = null;
    const t = html.match(/<title>([^<]+)<\/title>/);
    if (t) {
      title = entities(t[1]).replace(/\s*\|\s*Spotify\s*$/i, "").trim();
      const by = title.match(/^(.*?)\s+-\s+song(?: and lyrics)? by\s+(.+)$/i);
      if (by) { title = by[1].trim(); artist = by[2].trim(); }
    }
    if (!artist) {
      const a = html.match(/"artists":\s*\[\s*\{[^}]*?"name":\s*"([^"]+)"/)
        || html.match(/href="https:\/\/open\.spotify\.com\/artist\/[^"]+"[^>]*>([^<]+)</);
      if (a) artist = entities(a[1]).trim();
    }
    return title ? { title, artist } : null;
  } catch (err) {
    return null;
  }
}

const songLabel = s => `"${s.title}"` + (s.artist ? ` by ${s.artist}` : "");

function entities(s) {
  return s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

// Common two-character words, so a code that is also a real word says what that word means
let wordsPromise = null;
function loadWords() {
  if (!wordsPromise) {
    wordsPromise = fetch(WORDS_URL, { cf: { cacheTtl: 86400, cacheEverything: true } })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error("words " + r.status))))
      .catch(() => { wordsPromise = null; return {}; });
  }
  return wordsPromise;
}

function wordFor(code, words) {
  return (words && typeof words[code] === "string" && words[code]) || null;
}

// ---- Previews (unchanged) ----------------------------------------------------------------

async function preview(url) {
  const trackId = url.searchParams.get("id");

  if (!trackId || !/^[a-zA-Z0-9]{22}$/.test(trackId)) {
    return json({ error: "Missing or invalid track id" }, 400);
  }

  try {
    const embedRes = await fetch(`https://open.spotify.com/embed/track/${trackId}`, {
      headers: {
        "User-Agent": UA,
      },
    });

    if (!embedRes.ok) {
      return json({ error: "Could not load embed page" }, 502);
    }

    const html = await embedRes.text();
    let previewUrl = null;

    const match1 = html.match(/https:\/\/p\.scdn\.co\/mp3-preview\/[a-zA-Z0-9]+/);
    if (match1) previewUrl = match1[0];

    if (!previewUrl) {
      const nextDataMatch = html.match(/"audioPreview":\s*{\s*"url":\s*"([^"]+)"/);
      if (nextDataMatch) previewUrl = nextDataMatch[1];
    }

    let name = null;
    const nameMatch = html.match(/<title>([^<]+)<\/title>/);
    if (nameMatch) {
      name = nameMatch[1].replace(" | Spotify", "").trim();
    }

    return json({
      preview_url: previewUrl,
      name: name,
      source: previewUrl ? "embed" : null,
    });
  } catch (err) {
    return json({ error: "Server error", details: err.message }, 500);
  }
}

// ---- Helpers -------------------------------------------------------------------------------

function text(value, max) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

async function sha256(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      ...extraHeaders,
    },
  });
}
