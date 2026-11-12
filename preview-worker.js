// Spotiky Worker. Runs on Cloudflare Workers, not GitHub Pages.
// Live at https://spotiky-preview.spotikyhq.workers.dev
//
// Songs
//   GET  /?id=TRACK_ID        a track's preview MP3 and song name: { preview_url, name, source }
//   GET  /codes?c=夜光,𓇰𓇶      which song each code stands for: { "夜光": {type: "track", id}, "𓇰𓇶": null }
//   POST /suggest             { type: "track", id } -> code suggestions for the song
//   POST /claim               the same, plus { zh: {code, chars, why}, eg: {code, why}, em: {code, why} } -> saves them
// Playlists
//   GET  /playlist?id=5mh     a saved playlist: { id, items, labels, mine }
//   POST /playlist/suggest    { items } -> an ID and a set of four labels for the playlist
//   POST /playlist/save       { items, labels } saves it (signed in, it's yours); { edit: id, items } changes yours
//   GET  /playlists/mine      the signed-in person's playlists
// Accounts: email + a 6-digit code. Signed-in requests carry "Authorization: Bearer <token>".
//   POST /auth/start          { email } -> emails a sign-in code
//   POST /auth/verify         { email, code } -> { token }
//   GET  /auth/me             who's signed in
//   POST /auth/signout        ends this sign-in
//
// Settings (Worker -> Settings):
//   DB              binding to a D1 database; the Worker creates its own tables
//   AI              binding to Workers AI, which suggests codes from what a song is about
//   RESEND_API_KEY  secret: sends the sign-in codes (resend.com)
//   PEPPER          secret: long random text mixed into every stored hash. Never change it.
// Only hashes of emails, sign-in codes and sign-ins are stored, never the emails themselves.
//
// Songs: Spotify's Web API returns preview_url: null now, so previews come from the public
// embed page (open.spotify.com/embed/track/ID). Titles come from Spotify's oEmbed API,
// artists from the embed page.
//
// Song codes: a song gets one Chinese code (2-3 common Simplified characters), one
// hieroglyph code (2-3 signs from the Spotiky set of 98) and one emoji code (2-3 emoji that
// look the same on Windows, Mac, iPhone and Android). A code belongs to one song for good,
// first come, first served. The database itself refuses a second owner, so two people
// claiming the same code at the same moment can't both get it. Skin tones aren't part of a
// code: 👋🏾🌙 and 👋🌙 are one code, and the person sharing picks the tone for their link.
//
// Playlist links: spotiky.com/playlist/<id><label>, like 5mh夜歌 or 5mh-night-drive. The ID
// (3 or more characters from 32 that can't be mixed up, always with a digit) finds the
// playlist. The label is one of a matching set in Chinese, hieroglyphs, emoji and English;
// labels can repeat. Saved without signing in, a playlist is a snapshot whose ID comes from a
// fingerprint of its songs and times. A signed-in person's playlist gets its own ID and stays
// theirs to edit.

const MODEL = "@cf/qwen/qwen3-30b-a3b-fp8";
const WORDS_URL = "https://raw.githubusercontent.com/spotikyhq/spotiky/main/zh-words.json";
const FROM = "Spotiky <code@spotiky.com>";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
const SCRIPTS = ["zh", "eg", "em"];            // kinds of song code
const LABELS = ["zh", "eg", "em", "en"];       // kinds of playlist label
const CODE_RE = /^[\p{Script=Han}\p{Script=Egyptian_Hieroglyphs}\p{Emoji_Presentation}]{1,6}$/u;
const ID_RE = /^[a-zA-Z0-9]{22}$/;
const ITEM_RE = /^(?:[a-zA-Z0-9]{22}(?:\$\d+(?:-\d+)?)?|[\p{Script=Han}\p{Script=Egyptian_Hieroglyphs}\p{Emoji_Presentation}]{1,6}(?:\d+(?:-\d+)?)?)$/u;
const ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";   // no i, l, o or u: nothing to mix up with 1 or 0
// Every playlist ID has a digit (5mh, k7f), so a word is never read as an ID
const PLAYLIST_ID_RE = /^(?=.*[0-9])[0-9a-hjkmnp-tv-z]{3,13}$/;
// Words no ID may contain, also when spelled with numbers: a55, 5h1t, b00b, 8008, c0ck.
// Letters IDs can't have (i, l, o, u) only ever show up as their number stand-ins.
const ID_BLOCK = ["ass", "sex", "fag", "fgt", "fuck", "phuck", "fck", "fk", "kkk", "xxx", "wtf", "fap", "shit", "sht",
  "dick", "dck", "dik", "cock", "cunt", "cum", "piss", "tit", "boob", "penis", "porn", "slut", "whore", "hoe",
  "bitch", "btch", "twat", "wank", "jizz", "vag", "rape", "pedo", "kys", "nig", "negro", "nazi", "hitler", "1488",
  "kike", "spic", "chink", "gook", "coon", "jap", "wop", "dyke", "homo", "tranny", "retard"];
const LEET = { a: "4", b: "8", c: "k", e: "3", g: "69", i: "1", l: "1", o: "0", s: "5", t: "7", u: "v", z: "2" };
const ID_BLOCK_RE = new RegExp(ID_BLOCK.map(w => [...w].map(ch => LEET[ch] ? `[${ch}${LEET[ch]}]` : ch).join("")).join("|"));
const EN_RE = /^[a-z]{2,12}(?:-[a-z]{2,12})?$/;
const MINUTE = 60e3, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
const CODE_MINUTES = 10, CODE_TRIES = 5, SESSION_DAYS = 30;
const stripVS = s => String(s || "").replace(/[︎️]/g, "");   // ❤️ and ❤ are one code
const stripTones = s => String(s || "").replace(/[\u{1F3FB}-\u{1F3FF}]/gu, "");   // so are 👋🏾 and 👋
const canon = s => stripTones(stripVS(s));

// ---- Character data (generated from the Spotiky glyph review, China's 2013 character
// table and Unicode's emoji list: single emoji from Emoji 11.0 or earlier, no flags) ----
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
const EMOJI = [
  {"e": "😁", "name": "smiling eyes"},
  {"e": "😂", "name": "tears of joy"},
  {"e": "🙃", "name": "upside-down face"},
  {"e": "😉", "name": "winking face"},
  {"e": "😊", "name": "smiling eyes"},
  {"e": "😇", "name": "halo"},
  {"e": "🥰", "name": "hearts"},
  {"e": "😍", "name": "heart-eyes"},
  {"e": "🤩", "name": "star-struck"},
  {"e": "😘", "name": "kiss"},
  {"e": "😋", "name": "savoring food"},
  {"e": "🤪", "name": "zany face"},
  {"e": "🤑", "name": "money-mouth face"},
  {"e": "🤗", "name": "open hands"},
  {"e": "🤫", "name": "shushing face"},
  {"e": "🤔", "name": "thinking face"},
  {"e": "🤐", "name": "zipper-mouth face"},
  {"e": "😏", "name": "smirking face"},
  {"e": "🙄", "name": "rolling eyes"},
  {"e": "😬", "name": "grimacing face"},
  {"e": "🤥", "name": "lying face"},
  {"e": "😔", "name": "pensive face"},
  {"e": "😴", "name": "sleeping face"},
  {"e": "🥶", "name": "cold face"},
  {"e": "🤯", "name": "exploding head"},
  {"e": "🤠", "name": "cowboy hat face"},
  {"e": "🥳", "name": "partying face"},
  {"e": "😎", "name": "sunglasses"},
  {"e": "🤓", "name": "nerd face"},
  {"e": "😳", "name": "flushed face"},
  {"e": "🥺", "name": "pleading face"},
  {"e": "😭", "name": "loudly crying face"},
  {"e": "😱", "name": "screaming in fear"},
  {"e": "😤", "name": "steam from nose"},
  {"e": "😡", "name": "enraged face"},
  {"e": "😈", "name": "horns"},
  {"e": "💀", "name": "skull"},
  {"e": "🤡", "name": "clown face"},
  {"e": "👻", "name": "ghost"},
  {"e": "👽", "name": "alien"},
  {"e": "👾", "name": "alien monster"},
  {"e": "🤖", "name": "robot"},
  {"e": "🙈", "name": "see-no-evil monkey"},
  {"e": "💌", "name": "love letter"},
  {"e": "💘", "name": "heart with arrow"},
  {"e": "💖", "name": "sparkling heart"},
  {"e": "💔", "name": "broken heart"},
  {"e": "🧡", "name": "orange heart"},
  {"e": "💛", "name": "yellow heart"},
  {"e": "💚", "name": "green heart"},
  {"e": "💙", "name": "blue heart"},
  {"e": "💜", "name": "purple heart"},
  {"e": "🖤", "name": "black heart"},
  {"e": "💋", "name": "kiss mark"},
  {"e": "💯", "name": "hundred points"},
  {"e": "💥", "name": "collision"},
  {"e": "💫", "name": "dizzy"},
  {"e": "💨", "name": "dashing away"},
  {"e": "💬", "name": "speech balloon"},
  {"e": "💭", "name": "thought balloon"},
  {"e": "💤", "name": "ZZZ"},
  {"e": "👋", "name": "waving hand"},
  {"e": "🖖", "name": "vulcan salute"},
  {"e": "👌", "name": "OK hand"},
  {"e": "🤞", "name": "crossed fingers"},
  {"e": "🤘", "name": "sign of the horns"},
  {"e": "🤙", "name": "call me hand"},
  {"e": "👍", "name": "thumbs up"},
  {"e": "👎", "name": "thumbs down"},
  {"e": "✊", "name": "raised fist"},
  {"e": "👏", "name": "clapping hands"},
  {"e": "🙌", "name": "raising hands"},
  {"e": "🤝", "name": "handshake"},
  {"e": "🙏", "name": "folded hands"},
  {"e": "💅", "name": "nail polish"},
  {"e": "🤳", "name": "selfie"},
  {"e": "💪", "name": "flexed biceps"},
  {"e": "👂", "name": "ear"},
  {"e": "🧠", "name": "brain"},
  {"e": "👀", "name": "eyes"},
  {"e": "👶", "name": "baby"},
  {"e": "👼", "name": "baby angel"},
  {"e": "🎅", "name": "Santa Claus"},
  {"e": "🦸", "name": "superhero"},
  {"e": "🧙", "name": "mage"},
  {"e": "🧚", "name": "fairy"},
  {"e": "🧛", "name": "vampire"},
  {"e": "🧜", "name": "merperson"},
  {"e": "🧞", "name": "genie"},
  {"e": "🧟", "name": "zombie"},
  {"e": "🚶", "name": "person walking"},
  {"e": "🏃", "name": "person running"},
  {"e": "💃", "name": "woman dancing"},
  {"e": "🕺", "name": "man dancing"},
  {"e": "👯", "name": "people with bunny ears"},
  {"e": "🧗", "name": "person climbing"},
  {"e": "🏂", "name": "snowboarder"},
  {"e": "🏄", "name": "person surfing"},
  {"e": "🏊", "name": "person swimming"},
  {"e": "🤸", "name": "person cartwheeling"},
  {"e": "🤹", "name": "person juggling"},
  {"e": "🧘", "name": "person in lotus position"},
  {"e": "🛀", "name": "person taking bath"},
  {"e": "🛌", "name": "person in bed"},
  {"e": "💑", "name": "couple with heart"},
  {"e": "👣", "name": "footprints"},
  {"e": "🐵", "name": "monkey face"},
  {"e": "🦍", "name": "gorilla"},
  {"e": "🐶", "name": "dog face"},
  {"e": "🐺", "name": "wolf"},
  {"e": "🦊", "name": "fox"},
  {"e": "🦝", "name": "raccoon"},
  {"e": "🐱", "name": "cat face"},
  {"e": "🦁", "name": "lion"},
  {"e": "🐯", "name": "tiger face"},
  {"e": "🐆", "name": "leopard"},
  {"e": "🐴", "name": "horse face"},
  {"e": "🦄", "name": "unicorn"},
  {"e": "🦓", "name": "zebra"},
  {"e": "🦌", "name": "deer"},
  {"e": "🐮", "name": "cow face"},
  {"e": "🐷", "name": "pig face"},
  {"e": "🐗", "name": "boar"},
  {"e": "🐑", "name": "ewe"},
  {"e": "🐫", "name": "two-hump camel"},
  {"e": "🦙", "name": "llama"},
  {"e": "🦒", "name": "giraffe"},
  {"e": "🐘", "name": "elephant"},
  {"e": "🦏", "name": "rhinoceros"},
  {"e": "🐭", "name": "mouse face"},
  {"e": "🐰", "name": "rabbit face"},
  {"e": "🦔", "name": "hedgehog"},
  {"e": "🦇", "name": "bat"},
  {"e": "🐻", "name": "bear"},
  {"e": "🐨", "name": "koala"},
  {"e": "🐼", "name": "panda"},
  {"e": "🦘", "name": "kangaroo"},
  {"e": "🦡", "name": "badger"},
  {"e": "🐾", "name": "paw prints"},
  {"e": "🦃", "name": "turkey"},
  {"e": "🐓", "name": "rooster"},
  {"e": "🐣", "name": "hatching chick"},
  {"e": "🐦", "name": "bird"},
  {"e": "🐧", "name": "penguin"},
  {"e": "🦅", "name": "eagle"},
  {"e": "🦆", "name": "duck"},
  {"e": "🦢", "name": "swan"},
  {"e": "🦉", "name": "owl"},
  {"e": "🦚", "name": "peacock"},
  {"e": "🦜", "name": "parrot"},
  {"e": "🐸", "name": "frog"},
  {"e": "🐊", "name": "crocodile"},
  {"e": "🐢", "name": "turtle"},
  {"e": "🐍", "name": "snake"},
  {"e": "🐲", "name": "dragon face"},
  {"e": "🦖", "name": "T-Rex"},
  {"e": "🐳", "name": "spouting whale"},
  {"e": "🐠", "name": "tropical fish"},
  {"e": "🐡", "name": "blowfish"},
  {"e": "🦈", "name": "shark"},
  {"e": "🐙", "name": "octopus"},
  {"e": "🐚", "name": "spiral shell"},
  {"e": "🦀", "name": "crab"},
  {"e": "🦐", "name": "shrimp"},
  {"e": "🐌", "name": "snail"},
  {"e": "🦋", "name": "butterfly"},
  {"e": "🐛", "name": "bug"},
  {"e": "🐜", "name": "ant"},
  {"e": "🐝", "name": "honeybee"},
  {"e": "🐞", "name": "lady beetle"},
  {"e": "🦗", "name": "cricket"},
  {"e": "🦂", "name": "scorpion"},
  {"e": "💐", "name": "bouquet"},
  {"e": "🌸", "name": "cherry blossom"},
  {"e": "🌹", "name": "rose"},
  {"e": "🥀", "name": "wilted flower"},
  {"e": "🌻", "name": "sunflower"},
  {"e": "🌷", "name": "tulip"},
  {"e": "🌱", "name": "seedling"},
  {"e": "🌲", "name": "evergreen tree"},
  {"e": "🌳", "name": "deciduous tree"},
  {"e": "🌴", "name": "palm tree"},
  {"e": "🌵", "name": "cactus"},
  {"e": "🌾", "name": "sheaf of rice"},
  {"e": "🌿", "name": "herb"},
  {"e": "🍀", "name": "four leaf clover"},
  {"e": "🍁", "name": "maple leaf"},
  {"e": "🍄", "name": "mushroom"},
  {"e": "🍇", "name": "grapes"},
  {"e": "🍉", "name": "watermelon"},
  {"e": "🍊", "name": "tangerine"},
  {"e": "🍋", "name": "lemon"},
  {"e": "🍌", "name": "banana"},
  {"e": "🍍", "name": "pineapple"},
  {"e": "🥭", "name": "mango"},
  {"e": "🍎", "name": "red apple"},
  {"e": "🍐", "name": "pear"},
  {"e": "🍒", "name": "cherries"},
  {"e": "🍓", "name": "strawberry"},
  {"e": "🥝", "name": "kiwi fruit"},
  {"e": "🥥", "name": "coconut"},
  {"e": "🥑", "name": "avocado"},
  {"e": "🥔", "name": "potato"},
  {"e": "🥕", "name": "carrot"},
  {"e": "🌽", "name": "ear of corn"},
  {"e": "🥒", "name": "cucumber"},
  {"e": "🥬", "name": "leafy green"},
  {"e": "🥦", "name": "broccoli"},
  {"e": "🥜", "name": "peanuts"},
  {"e": "🍞", "name": "bread"},
  {"e": "🥐", "name": "croissant"},
  {"e": "🥞", "name": "pancakes"},
  {"e": "🧀", "name": "cheese wedge"},
  {"e": "🍗", "name": "poultry leg"},
  {"e": "🥩", "name": "cut of meat"},
  {"e": "🍔", "name": "hamburger"},
  {"e": "🍟", "name": "french fries"},
  {"e": "🍕", "name": "pizza"},
  {"e": "🌭", "name": "hot dog"},
  {"e": "🥪", "name": "sandwich"},
  {"e": "🌮", "name": "taco"},
  {"e": "🥚", "name": "egg"},
  {"e": "🍳", "name": "cooking"},
  {"e": "🥗", "name": "green salad"},
  {"e": "🍿", "name": "popcorn"},
  {"e": "🧂", "name": "salt"},
  {"e": "🥫", "name": "canned food"},
  {"e": "🍱", "name": "bento box"},
  {"e": "🍙", "name": "rice ball"},
  {"e": "🍜", "name": "steaming bowl"},
  {"e": "🍝", "name": "spaghetti"},
  {"e": "🍣", "name": "sushi"},
  {"e": "🍡", "name": "dango"},
  {"e": "🥟", "name": "dumpling"},
  {"e": "🥠", "name": "fortune cookie"},
  {"e": "🥡", "name": "takeout box"},
  {"e": "🍦", "name": "soft ice cream"},
  {"e": "🍩", "name": "doughnut"},
  {"e": "🍪", "name": "cookie"},
  {"e": "🎂", "name": "birthday cake"},
  {"e": "🧁", "name": "cupcake"},
  {"e": "🥧", "name": "pie"},
  {"e": "🍫", "name": "chocolate bar"},
  {"e": "🍬", "name": "candy"},
  {"e": "🍭", "name": "lollipop"},
  {"e": "🍮", "name": "custard"},
  {"e": "🍯", "name": "honey pot"},
  {"e": "☕", "name": "hot beverage"},
  {"e": "🍵", "name": "teacup without handle"},
  {"e": "🍾", "name": "bottle with popping cork"},
  {"e": "🍷", "name": "wine glass"},
  {"e": "🍸", "name": "cocktail glass"},
  {"e": "🍹", "name": "tropical drink"},
  {"e": "🍻", "name": "clinking beer mugs"},
  {"e": "🥂", "name": "clinking glasses"},
  {"e": "🥃", "name": "tumbler glass"},
  {"e": "🥤", "name": "cup with straw"},
  {"e": "🌍", "name": "globe showing Europe-Africa"},
  {"e": "🧭", "name": "compass"},
  {"e": "🌋", "name": "volcano"},
  {"e": "🧱", "name": "brick"},
  {"e": "🏠", "name": "house"},
  {"e": "🏥", "name": "hospital"},
  {"e": "🏭", "name": "factory"},
  {"e": "🏰", "name": "castle"},
  {"e": "💒", "name": "wedding"},
  {"e": "🗼", "name": "Tokyo tower"},
  {"e": "🗽", "name": "Statue of Liberty"},
  {"e": "⛲", "name": "fountain"},
  {"e": "⛺", "name": "tent"},
  {"e": "🌃", "name": "night with stars"},
  {"e": "🌅", "name": "sunrise"},
  {"e": "🎠", "name": "carousel horse"},
  {"e": "🎡", "name": "ferris wheel"},
  {"e": "🎢", "name": "roller coaster"},
  {"e": "🎪", "name": "circus tent"},
  {"e": "🚂", "name": "locomotive"},
  {"e": "🚌", "name": "bus"},
  {"e": "🚑", "name": "ambulance"},
  {"e": "🚒", "name": "fire engine"},
  {"e": "🚕", "name": "taxi"},
  {"e": "🚗", "name": "automobile"},
  {"e": "🚜", "name": "tractor"},
  {"e": "🛵", "name": "motor scooter"},
  {"e": "🚲", "name": "bicycle"},
  {"e": "🛹", "name": "skateboard"},
  {"e": "🚨", "name": "police car light"},
  {"e": "🚦", "name": "vertical traffic light"},
  {"e": "🛑", "name": "stop sign"},
  {"e": "⚓", "name": "anchor"},
  {"e": "⛵", "name": "sailboat"},
  {"e": "🛶", "name": "canoe"},
  {"e": "🚢", "name": "ship"},
  {"e": "🛫", "name": "airplane departure"},
  {"e": "🚁", "name": "helicopter"},
  {"e": "🚀", "name": "rocket"},
  {"e": "🛸", "name": "flying saucer"},
  {"e": "🧳", "name": "luggage"},
  {"e": "⌛", "name": "hourglass done"},
  {"e": "⏰", "name": "alarm clock"},
  {"e": "🌕", "name": "full moon"},
  {"e": "🌙", "name": "crescent moon"},
  {"e": "🌞", "name": "sun with face"},
  {"e": "🌟", "name": "glowing star"},
  {"e": "🌠", "name": "shooting star"},
  {"e": "⛅", "name": "sun behind cloud"},
  {"e": "🌀", "name": "cyclone"},
  {"e": "🌈", "name": "rainbow"},
  {"e": "☔", "name": "umbrella with rain drops"},
  {"e": "⚡", "name": "high voltage"},
  {"e": "⛄", "name": "snowman without snow"},
  {"e": "🔥", "name": "fire"},
  {"e": "💧", "name": "droplet"},
  {"e": "🌊", "name": "water wave"},
  {"e": "🎃", "name": "jack-o-lantern"},
  {"e": "🎄", "name": "Christmas tree"},
  {"e": "🎆", "name": "fireworks"},
  {"e": "✨", "name": "sparkles"},
  {"e": "🎈", "name": "balloon"},
  {"e": "🎉", "name": "party popper"},
  {"e": "🎀", "name": "ribbon"},
  {"e": "🎁", "name": "wrapped gift"},
  {"e": "🎫", "name": "ticket"},
  {"e": "🏆", "name": "trophy"},
  {"e": "🥇", "name": "1st place medal"},
  {"e": "⚽", "name": "soccer ball"},
  {"e": "⚾", "name": "baseball"},
  {"e": "🏀", "name": "basketball"},
  {"e": "🏈", "name": "american football"},
  {"e": "🎾", "name": "tennis"},
  {"e": "🎳", "name": "bowling"},
  {"e": "🏓", "name": "ping pong"},
  {"e": "🥊", "name": "boxing glove"},
  {"e": "⛳", "name": "flag in hole"},
  {"e": "🎣", "name": "fishing pole"},
  {"e": "🎿", "name": "skis"},
  {"e": "🎯", "name": "bullseye"},
  {"e": "🎱", "name": "pool 8 ball"},
  {"e": "🔮", "name": "crystal ball"},
  {"e": "🎮", "name": "video game"},
  {"e": "🎰", "name": "slot machine"},
  {"e": "🎲", "name": "game die"},
  {"e": "🧩", "name": "puzzle piece"},
  {"e": "🧸", "name": "teddy bear"},
  {"e": "🃏", "name": "joker"},
  {"e": "🎭", "name": "performing arts"},
  {"e": "🎨", "name": "artist palette"},
  {"e": "🧶", "name": "yarn"},
  {"e": "👓", "name": "glasses"},
  {"e": "👕", "name": "t-shirt"},
  {"e": "👖", "name": "jeans"},
  {"e": "🧣", "name": "scarf"},
  {"e": "🧤", "name": "gloves"},
  {"e": "🧥", "name": "coat"},
  {"e": "🧦", "name": "socks"},
  {"e": "👗", "name": "dress"},
  {"e": "👙", "name": "bikini"},
  {"e": "👜", "name": "handbag"},
  {"e": "🎒", "name": "backpack"},
  {"e": "👟", "name": "running shoe"},
  {"e": "👠", "name": "high-heeled shoe"},
  {"e": "👢", "name": "woman’s boot"},
  {"e": "👑", "name": "crown"},
  {"e": "👒", "name": "woman’s hat"},
  {"e": "🎩", "name": "top hat"},
  {"e": "🎓", "name": "graduation cap"},
  {"e": "🧢", "name": "billed cap"},
  {"e": "💄", "name": "lipstick"},
  {"e": "💍", "name": "ring"},
  {"e": "💎", "name": "gem stone"},
  {"e": "🔊", "name": "speaker high volume"},
  {"e": "📢", "name": "loudspeaker"},
  {"e": "🔔", "name": "bell"},
  {"e": "🎼", "name": "musical score"},
  {"e": "🎶", "name": "musical notes"},
  {"e": "🎤", "name": "microphone"},
  {"e": "🎧", "name": "headphone"},
  {"e": "📻", "name": "radio"},
  {"e": "🎷", "name": "saxophone"},
  {"e": "🎸", "name": "guitar"},
  {"e": "🎹", "name": "musical keyboard"},
  {"e": "🎺", "name": "trumpet"},
  {"e": "🎻", "name": "violin"},
  {"e": "🥁", "name": "drum"},
  {"e": "📱", "name": "mobile phone"},
  {"e": "📞", "name": "telephone receiver"},
  {"e": "🔋", "name": "battery"},
  {"e": "💻", "name": "laptop"},
  {"e": "💿", "name": "optical disk"},
  {"e": "🎥", "name": "movie camera"},
  {"e": "🎬", "name": "clapper board"},
  {"e": "📺", "name": "television"},
  {"e": "📷", "name": "camera"},
  {"e": "📼", "name": "videocassette"},
  {"e": "🔍", "name": "magnifying glass tilted left"},
  {"e": "💡", "name": "light bulb"},
  {"e": "🔦", "name": "flashlight"},
  {"e": "🏮", "name": "red paper lantern"},
  {"e": "📖", "name": "open book"},
  {"e": "📚", "name": "books"},
  {"e": "📜", "name": "scroll"},
  {"e": "📰", "name": "newspaper"},
  {"e": "🔖", "name": "bookmark"},
  {"e": "💰", "name": "money bag"},
  {"e": "💸", "name": "money with wings"},
  {"e": "💳", "name": "credit card"},
  {"e": "📦", "name": "package"},
  {"e": "📮", "name": "postbox"},
  {"e": "📝", "name": "memo"},
  {"e": "💼", "name": "briefcase"},
  {"e": "📅", "name": "calendar"},
  {"e": "📈", "name": "chart increasing"},
  {"e": "📉", "name": "chart decreasing"},
  {"e": "📌", "name": "pushpin"},
  {"e": "📎", "name": "paperclip"},
  {"e": "🔒", "name": "locked"},
  {"e": "🔑", "name": "key"},
  {"e": "🔨", "name": "hammer"},
  {"e": "🏹", "name": "bow and arrow"},
  {"e": "🔧", "name": "wrench"},
  {"e": "🔗", "name": "link"},
  {"e": "🧰", "name": "toolbox"},
  {"e": "🧲", "name": "magnet"},
  {"e": "🧪", "name": "test tube"},
  {"e": "🧬", "name": "dna"},
  {"e": "🔬", "name": "microscope"},
  {"e": "🔭", "name": "telescope"},
  {"e": "📡", "name": "satellite antenna"},
  {"e": "🚪", "name": "door"},
  {"e": "🛁", "name": "bathtub"},
  {"e": "🧹", "name": "broom"},
  {"e": "🛒", "name": "shopping cart"},
  {"e": "🧿", "name": "nazar amulet"},
  {"e": "🗿", "name": "moai"},
];
const TONEABLE = new Set("👋🖖👌🤞🤘🤙👍👎✊👏🙌🙏💅🤳💪👂👶👼🎅🦸🧙🧚🧛🧜🚶🏃💃🕺🧗🏂🏄🏊🤸🤹🧘🛀🛌");   // emoji whose five skin tones show everywhere (Emoji 11.0 or earlier)
// English words a label can't use: the LDNOOBW list (github.com/LDNOOBW, CC BY 4.0)
const EN_BLOCK = new Set(["acrotomophilia", "alabama-hot-pocket", "alaskan-pipeline", "anal", "anilingus", "anus", "apeshit", "arsehole", "ass", "asshole", "assmunch", "auto-erotic", "autoerotic", "babeland", "baby-batter", "baby-juice", "ball-gag", "ball-gravy", "ball-kicking", "ball-licking", "ball-sack", "ball-sucking", "bangbros", "bangbus", "bareback", "barely-legal", "barenaked", "bastard", "bastardo", "bastinado", "bbw", "bdsm", "beaner", "beaners", "beastiality", "beaver-cleaver", "beaver-lips", "bestiality", "big-black", "big-breasts", "big-knockers", "big-tits", "bimbos", "birdlock", "bitch", "bitches", "black-cock", "blonde-action", "blonde-on-blonde-action", "blow-job", "blow-your-load", "blowjob", "blue-waffle", "blumpkin", "bollocks", "bondage", "boner", "boob", "boobs", "booty-call", "brown-showers", "brunette-action", "bukkake", "bulldyke", "bullet-vibe", "bullshit", "bung-hole", "bunghole", "busty", "butt", "buttcheeks", "butthole", "camel-toe", "camgirl", "camslut", "camwhore", "carpet-muncher", "carpetmuncher", "chocolate-rosebuds", "cialis", "circlejerk", "cleveland-steamer", "clit", "clitoris", "clover-clamps", "clusterfuck", "cock", "cocks", "coon", "coons", "coprolagnia", "coprophilia", "cornhole", "creampie", "cum", "cumming", "cumshot", "cumshots", "cunnilingus", "cunt", "darkie", "date-rape", "daterape", "deep-throat", "deepthroat", "dendrophilia", "dick", "dildo", "dingleberries", "dingleberry", "dirty-pillows", "dirty-sanchez", "dog-style", "doggie-style", "doggiestyle", "doggy-style", "doggystyle", "dolcett", "domination", "dominatrix", "dommes", "donkey-punch", "double-dong", "double-penetration", "dp-action", "dry-hump", "dvda", "eat-my-ass", "ecchi", "ejaculation", "erotic", "erotism", "escort", "eunuch", "fag", "faggot", "fecal", "felch", "fellatio", "feltch", "female-squirting", "femdom", "figging", "fingerbang", "fingering", "fisting", "foot-fetish", "footjob", "frotting", "fuck", "fuck-buttons", "fuckin", "fucking", "fucktards", "fudge-packer", "fudgepacker", "futanari", "gang-bang", "gangbang", "gay-sex", "genitals", "giant-cock", "girl-on", "girl-on-top", "girls-gone-wild", "goatcx", "goatse", "god-damn", "gokkun", "golden-shower", "goo-girl", "goodpoop", "goregasm", "grope", "group-sex", "guro", "hand-job", "handjob", "hard-core", "hardcore", "hentai", "homoerotic", "honkey", "hooker", "horny", "hot-carl", "hot-chick", "how-to-kill", "how-to-murder", "huge-fat", "humping", "incest", "intercourse", "jack-off", "jail-bait", "jailbait", "jelly-donut", "jerk-off", "jigaboo", "jiggaboo", "jiggerboo", "jizz", "juggs", "kike", "kinbaku", "kinkster", "kinky", "knobbing", "leather-restraint", "leather-straight-jacket", "lemon-party", "livesex", "lolita", "lovemaking", "make-me-come", "male-squirting", "masturbate", "masturbating", "masturbation", "menage-a-trois", "milf", "missionary-position", "mong", "motherfucker", "mound-of-venus", "mr-hands", "muff-diver", "muffdiving", "nambla", "nawashi", "negro", "neonazi", "nig-nog", "nigga", "nigger", "nimphomania", "nipple", "nipples", "nsfw", "nsfw-images", "nude", "nudity", "nutten", "nympho", "nymphomania", "octopussy", "omorashi", "one-cup-two-girls", "one-guy-one-jar", "orgasm", "orgy", "paedophile", "paki", "panties", "panty", "pedobear", "pedophile", "pegging", "penis", "phone-sex", "piece-of-shit", "pikey", "piss-pig", "pissing", "pisspig", "playboy", "pleasure-chest", "pole-smoker", "ponyplay", "poof", "poon", "poontang", "poop-chute", "poopchute", "porn", "porno", "pornography", "prince-albert-piercing", "pthc", "pubes", "punany", "pussy", "queaf", "queef", "quim", "raghead", "raging-boner", "rape", "raping", "rapist", "rectum", "reverse-cowgirl", "rimjob", "rimming", "rosy-palm", "rusty-trombone", "sadism", "santorum", "scat", "schlong", "scissoring", "semen", "sex", "sexcam", "sexo", "sexual", "sexuality", "sexually", "sexy", "shaved-beaver", "shaved-pussy", "shemale", "shibari", "shit", "shitblimp", "shitty", "shota", "shrimping", "skeet", "slanteye", "slut", "smut", "snatch", "snowballing", "sodomize", "sodomy", "spastic", "spic", "splooge", "splooge-moose", "spooge", "spread-legs", "spunk", "strap-on", "strapon", "strappado", "strip-club", "style-doggy", "suck", "sucks", "suicide-girls", "sultry-women", "swastika", "swinger", "tainted-love", "taste-my", "tea-bagging", "threesome", "throating", "thumbzilla", "tied-up", "tight-white", "tit", "tits", "titties", "titty", "tongue-in-a", "topless", "tosser", "towelhead", "tranny", "tribadism", "tub-girl", "tubgirl", "tushy", "twat", "twink", "twinkie", "two-girls-one-cup", "undressing", "upskirt", "urethra-play", "urophilia", "vagina", "venus-mound", "viagra", "vibrator", "violet-wand", "vorarephilia", "voyeur", "voyeurweb", "voyuer", "vulva", "wank", "wet-dream", "wetback", "white-power", "whore", "worldsex", "wrapping-men", "wrinkled-starfish", "xx", "xxx", "yaoi", "yellow-showers", "yiffy", "zoophilia"]);
const GLYPH_BY_CHAR = new Map(GLYPHS.map(g => [g.c, g]));
const EMOJI_BY_CHAR = new Map(EMOJI.map(x => [x.e, x]));

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const ROUTES = {
  "GET /codes": codes,
  "POST /suggest": suggest,
  "POST /claim": claim,
  "GET /playlist": getPlaylist,
  "POST /playlist/suggest": suggestPlaylist,
  "POST /playlist/save": savePlaylist,
  "GET /playlists/mine": myPlaylists,
  "POST /auth/start": startSignIn,
  "POST /auth/verify": verifySignIn,
  "GET /auth/me": me,
  "POST /auth/signout": signOut,
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(request.url);
    const handler = ROUTES[`${request.method} ${url.pathname}`];
    if (!handler) return preview(url);
    const body = request.method === "POST" ? await request.json().catch(() => null) : null;
    const req = { url, body, request, env };
    try {
      return await handler(req);
    } catch (err) {
      // A new database has no tables yet: make them, then try once more
      if (env.DB && /no such table/i.test(String(err && err.message))) {
        try {
          await env.DB.batch(SCHEMA.map(s => env.DB.prepare(s)));
          return await handler(req);
        } catch (err2) {
          return serverError(err2);
        }
      }
      return serverError(err);
    }
  },
};

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS song_codes (code TEXT PRIMARY KEY, script TEXT NOT NULL, track TEXT NOT NULL,
     chars TEXT, word TEXT, why TEXT, created TEXT NOT NULL, UNIQUE (track, script))`,
  `CREATE TABLE IF NOT EXISTS zh_shapes (shape TEXT PRIMARY KEY, code TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS playlists (id TEXT PRIMARY KEY, items TEXT NOT NULL, hash TEXT NOT NULL, owner TEXT,
     labels TEXT NOT NULL, why TEXT, created TEXT NOT NULL, updated TEXT NOT NULL)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS playlist_snapshots ON playlists (hash) WHERE owner IS NULL`,
  `CREATE INDEX IF NOT EXISTS playlists_by_owner ON playlists (owner, updated)`,
  `CREATE TABLE IF NOT EXISTS owners (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, created TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sign_in_codes (email TEXT PRIMARY KEY, code TEXT NOT NULL, expires INTEGER NOT NULL,
     tries INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, owner TEXT NOT NULL, expires INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sends (key TEXT NOT NULL, at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS sends_by_key ON sends (key, at)`,
];

const notSetUp = () => json({ error: "Codes aren't set up on this Worker yet. It needs its DB binding." }, 503);
const serverError = err => json({ error: "Server error", details: String((err && err.message) || err) }, 500);

// ---- Song codes: looking up -----------------------------------------------------------

async function codes({ url, env }) {
  if (!env.DB) return notSetUp();
  const list = [...new Set((url.searchParams.get("c") || "").split(",").map(c => stripVS(c).trim()).filter(Boolean))];
  if (!list.length || list.length > 50) {
    return json({ error: "Pass 1 to 50 codes, separated by commas, as ?c=" }, 400);
  }
  const keys = [...new Set(list.map(stripTones).filter(c => CODE_RE.test(c)))];
  const rows = keys.length
    ? (await env.DB.prepare(`SELECT code, track FROM song_codes WHERE code IN (${keys.map(() => "?").join(",")})`).bind(...keys).all()).results
    : [];
  const found = new Map(rows.map(r => [r.code, r.track]));
  const out = {};
  for (const asked of list) {   // answered under the code as asked, skin tone and all
    const track = found.get(stripTones(asked));
    out[asked] = track ? { type: "track", id: track } : null;
  }
  // A saved code never changes, so answers can be cached; "no song yet" can change any minute
  const allFound = list.every(c => out[c]);
  return json(out, 200, { "Cache-Control": allFound ? "public, max-age=300" : "no-store" });
}

// The codes a song already has: { zh?, eg?, em? }, each marked saved
async function songCodes(db, track) {
  const rows = (await db.prepare("SELECT code, script, chars, word, why FROM song_codes WHERE track = ?").bind(track).all()).results;
  const out = {};
  for (const r of rows) {
    out[r.script] = r.script === "zh"
      ? { code: r.code, chars: parseChars(r.chars, r.code), word: r.word || null, why: r.why || "", saved: true }
      : { code: r.code, chars: [...r.code].map(r.script === "eg" ? glyphChar : emojiChar), why: r.why || "", saved: true };
  }
  return out;
}

function parseChars(value, code) {
  try {
    const list = JSON.parse(value || "[]");
    if (Array.isArray(list) && list.length === [...code].length) return list;
  } catch (err) {}
  return [...code].map(ch => ({ char: ch, meaning: "" }));
}

// ---- Song codes: suggesting -----------------------------------------------------------

async function suggest({ body, env }) {
  if (!env.DB) return notSetUp();
  const track = body && body.type === "track" && ID_RE.test(body.id || "") ? body.id : null;
  if (!track) return json({ error: "Send a song id" }, 400);

  // Codes the song already has stay; only kinds it doesn't have yet get suggestions
  const saved = await songCodes(env.DB, track);
  const missing = SCRIPTS.filter(s => !saved[s]);
  if (!missing.length) return json({ existing: true, ...saved });

  if (!env.AI) return json({ error: "Code suggestions aren't set up on this Worker yet" }, 503);
  const songs = await songsFor(track, env.DB);
  if (!songs.length) return json({ error: "Couldn't read this song from Spotify. Try again in a moment." }, 502);

  const words = await loadWords();
  const built = await askForCodes(env, songs, false, missing, words);
  if (missing.every(s => !built[s].cands.length)) {
    if (Object.keys(saved).length) return json({ existing: true, ...saved });
    return json({ error: "Couldn't come up with codes for this one. Try again." }, 502);
  }
  const picks = await Promise.all(missing.map(s => pickFree(env.DB, s, built[s], track, words)));
  const out = { ...saved };
  missing.forEach((s, i) => { if (picks[i]) out[s] = { ...picks[i], saved: false }; });
  return json({ existing: false, ...out, about: songs.map(songLabel) });
}

// The first suggestion nobody else has. If every one is taken, add a third character.
async function pickFree(db, script, built, track, words) {
  if (!built.cands.length) return null;
  for (const c of built.cands) {
    if (await isFree(db, script, c.code, track)) return withOptions(c, built, false);
  }
  const first = built.cands[0];
  for (const extra of built.alts[1] || []) {
    const code = first.code + extra.char;
    if (problem(script, code) || !(await isFree(db, script, code, track))) continue;
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

async function isFree(db, script, code, track) {
  const row = await db.prepare("SELECT track FROM song_codes WHERE code = ?").bind(code).first();
  if (row && row.track !== track) return false;
  if (script === "zh" && hasShapeChar(code)) {
    const shape = await db.prepare("SELECT code FROM zh_shapes WHERE shape = ?").bind(shapeOf(code)).first();
    if (shape && shape.code !== code) return false;   // a look-alike of a code that exists
  }
  return true;
}

// ---- Song codes: saving ------------------------------------------------------------------

async function claim({ body, env, request }) {
  if (!env.DB) return notSetUp();
  const db = env.DB;
  const track = body && body.type === "track" && ID_RE.test(body.id || "") ? body.id : null;
  if (!track) return json({ error: "Send a song id" }, 400);
  if (!(await allow(db, "claim:" + (await ipKey(request, env)), 30, HOUR))) {
    return json({ error: "Too many codes saved from here. Try again in a while." }, 429);
  }

  let saved = await songCodes(db, track);
  let codes = wantedCodes(body, saved);
  if (!Object.keys(codes).length) {
    if (Object.keys(saved).length) return json({ existing: true, ...saved });
    return json({ error: "Send a Chinese, hieroglyph or emoji code" }, 400);
  }
  for (const [script, code] of Object.entries(codes)) {
    const why = problem(script, code);
    if (why) return json({ error: why, script, code }, 400);
    if (!(await isFree(db, script, code, track))) return takenReply(script, code);
  }
  // Only real songs get codes, so nobody can sit on codes with made-up song IDs
  if (!(await oembedTitle(track)) && !(await embedPage(track))) {
    return json({ error: "Couldn't find this song on Spotify." }, 404);
  }

  const words = await loadWords();
  for (let attempt = 0; attempt < 2; attempt++) {
    const at = new Date().toISOString();
    const out = {}, writes = [];
    for (const [script, code] of Object.entries(codes)) {
      const given = body[script] || {};
      const why = text(given.why, 90);
      if (script === "zh") {
        const g = Array.isArray(given.chars) ? given.chars : [];
        const chars = [...code].map((ch, i) => ({ char: ch, meaning: text(g[i] && g[i].char === ch ? g[i].meaning : "", 30) }));
        const word = wordFor(code, words) || text(given.word, 40) || null;
        out.zh = { code, chars, word, why, saved: true };
        writes.push(db.prepare("INSERT INTO song_codes (code, script, track, chars, word, why, created) VALUES (?, 'zh', ?, ?, ?, ?, ?)")
          .bind(code, track, JSON.stringify(chars), word, why, at));
        if (hasShapeChar(code)) writes.push(db.prepare("INSERT INTO zh_shapes (shape, code) VALUES (?, ?)").bind(shapeOf(code), code));
      } else {
        out[script] = { code, chars: [...code].map(script === "eg" ? glyphChar : emojiChar), why, saved: true };
        writes.push(db.prepare("INSERT INTO song_codes (code, script, track, chars, word, why, created) VALUES (?, ?, ?, NULL, NULL, ?, ?)")
          .bind(code, script, track, why, at));
      }
    }
    try {
      // One transaction: every code is saved, or none is
      await db.batch(writes);
      return json({ existing: Object.keys(saved).length > 0, ...saved, ...out });
    } catch (err) {
      if (!isConflict(err)) throw err;
    }
    // Someone else saved first: a code went to another song, or this song gained codes
    saved = await songCodes(db, track);
    for (const [script, code] of Object.entries(codes)) {
      if (!saved[script] && !(await isFree(db, script, code, track))) return takenReply(script, code, true);
    }
    codes = wantedCodes(body, saved);
    if (!Object.keys(codes).length) break;
  }
  return json({ existing: true, ...saved });
}

function wantedCodes(body, saved) {
  const codes = {};
  for (const s of SCRIPTS) {
    const raw = body[s] && typeof body[s].code === "string" ? canon(body[s].code).replace(/\s+/g, "") : "";
    if (raw && !saved[s]) codes[s] = raw;   // kinds the song already has stay as they are
  }
  return codes;
}

function takenReply(script, code, justNow) {
  const whose = script === "zh" ? "song or a look-alike code" : "song";
  return json({ error: `${code} ${justNow ? "just went" : "already belongs"} to another ${whose}`, script, code, taken: true }, 409);
}

// ---- Asking the AI ---------------------------------------------------------------------------

const SYSTEM = "You name songs with short, poetic codes for Spotiky, a music link app. You write in your own words, never quote song lyrics, and reply with JSON only.";

// Suggestions for the given kinds: { zh: {cands, alts}, ... }. Asks a second time if the first answer is unusable.
async function askForCodes(env, songs, isPlaylist, kinds, words) {
  const readers = { zh: ai => readChinese(ai, words), eg: readGlyphs, em: readEmoji, en: readEnglish };
  const prompt = buildPrompt(songs, isPlaylist);
  const built = Object.fromEntries(kinds.map(s => [s, { cands: [], alts: [] }]));
  for (let attempt = 0; attempt < 2 && kinds.some(s => !built[s].cands.length); attempt++) {
    const ai = await askAI(env, prompt, isPlaylist ? 1700 : 1400);
    for (const s of kinds) if (!built[s].cands.length) built[s] = readers[s](ai);
  }
  return built;
}

function buildPrompt(songs, isPlaylist) {
  const subject = isPlaylist
    ? `a playlist of these songs:\n${songs.map((s, i) => `${i + 1}. ${songLabel(s)}`).join("\n")}`
    : `the song ${songLabel(songs[0])}`;
  const what = isPlaylist ? "playlist" : "song";
  const glyphLines = GLYPHS.map(g => `${g.c} ${g.name}: ${g.meaning}`).join("\n");
  const english = isPlaylist
    ? `\nEnglish: give 3 different labels. Each is one or two common English words in lowercase, joined by a hyphen when there are two (like "night-drive"), that capture the playlist.\n`
    : "";
  return `Make Spotiky codes for ${subject}

A code is two characters that capture what the ${what} is about: its story, mood or imagery, not just the words in its title. Describe themes in your own words and never quote lyrics.

Chinese: give 3 different codes. Each is 2 common Simplified Chinese characters that read naturally to a Chinese speaker, as a real word or a poetic pair. Avoid slang, rude, unlucky or political readings. Give each character a short English meaning. If the pair is an existing Chinese word, put that word's meaning in "word", otherwise null.

Hieroglyphs: give 3 different codes. Each is 2 signs taken only from this list (sign, name: meaning):
${glyphLines}

Emoji: give 3 different codes. Each is 2 emoji, taken only from this list, that tell the ${what}'s story at a glance. Leave people and hands in their default color with no skin tone; the person sharing picks one.
${EMOJI.map(x => x.e).join("")}
${english}
For every kind, also give 4 alternatives for each position of your first code: characters, signs, emoji${isPlaylist ? " or words" : ""} that would also fit in that spot.
Write each "why" as one short English line, under 12 words, about the ${what}.

Reply with JSON only, in exactly this shape:
{"zh":[{"code":"..","chars":[{"char":"..","meaning":".."},{"char":"..","meaning":".."}],"word":null,"why":".."}],
"zh_alts":[[{"char":"..","meaning":".."}],[{"char":"..","meaning":".."}]],
"eg":[{"code":"..","why":".."}],
"eg_alts":[["..",".."],["..",".."]],
"em":[{"code":"..","why":".."}],
"em_alts":[["..",".."],["..",".."]]${isPlaylist ? `,
"en":[{"code":"..","why":".."}],
"en_alts":[["..",".."],["..",".."]]` : ""}}
/no_think`;
}

async function askAI(env, prompt, maxTokens) {
  try {
    const res = await env.AI.run(MODEL, {
      messages: [{ role: "system", content: SYSTEM }, { role: "user", content: prompt }],
      max_tokens: maxTokens,
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

function readEmoji(ai) {
  const cands = [];
  for (const c of Array.isArray(ai && ai.em) ? ai.em : []) {
    const code = typeof (c && c.code) === "string" ? canon(c.code).replace(/\s+/g, "") : "";
    if (emProblem(code) || cands.some(x => x.code === code)) continue;
    cands.push({ code, chars: [...code].map(emojiChar), why: text(c.why, 90) });
  }
  const alts = [0, 1].map(i => {
    const list = Array.isArray(ai && ai.em_alts) && Array.isArray(ai.em_alts[i]) ? ai.em_alts[i] : [];
    return list.map(a => canon(typeof a === "string" ? a : (a && a.char) || "")).filter(a => EMOJI_BY_CHAR.has(a)).map(emojiChar);
  });
  return { cands, alts };
}

// toneable: the page offers skin tones for it
function emojiChar(ch) {
  const x = EMOJI_BY_CHAR.get(ch);
  return { char: ch, name: x ? x.name : "", meaning: x ? x.name : "", toneable: TONEABLE.has(ch) };
}

// English labels are words; each word is one swappable "character"
function readEnglish(ai) {
  const cands = [];
  for (const c of Array.isArray(ai && ai.en) ? ai.en : []) {
    const code = cleanEnglish(c && c.code);
    if (enProblem(code) || cands.some(x => x.code === code)) continue;
    cands.push({ code, chars: code.split("-").map(wordChar), why: text(c.why, 90) });
  }
  const alts = [0, 1].map(i => {
    const list = Array.isArray(ai && ai.en_alts) && Array.isArray(ai.en_alts[i]) ? ai.en_alts[i] : [];
    return list.map(a => cleanEnglish(typeof a === "string" ? a : a && a.char))
      .filter(w => /^[a-z]{2,12}$/.test(w) && !EN_BLOCK.has(w)).map(wordChar);
  });
  return { cands, alts };
}

const cleanEnglish = v => (typeof v === "string" ? v.trim().toLowerCase().replace(/[\s_]+/g, "-") : "");
const wordChar = w => ({ char: w, name: "", meaning: "" });

// ---- Rules for codes and labels --------------------------------------------------------

function problem(script, code) {
  return script === "zh" ? zhProblem(code) : script === "eg" ? egProblem(code) : script === "em" ? emProblem(code) : enProblem(code);
}

function emProblem(code) {
  const cs = [...String(code || "")];
  if (cs.length < 2 || cs.length > 3) return "An emoji code needs 2 or 3 emoji";
  if (!cs.every(c => EMOJI_BY_CHAR.has(c))) return "Emoji codes use emoji from the Spotiky set only";
  return null;
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

function enProblem(label) {
  if (!EN_RE.test(label || "") || label.length > 20) return "An English label is one or two lowercase words, like night-drive";
  if (EN_BLOCK.has(label) || label.split("-").some(w => EN_BLOCK.has(w))) return "That label uses a word Spotiky doesn't use";
  return null;
}

const hasShapeChar = code => [...code].some(c => ZH_SHAPES[c]);
const shapeOf = code => [...code].map(c => ZH_SHAPES[c] || c).join("");

// ---- Playlists ------------------------------------------------------------------------------

// A playlist's songs written one standard way, or null: "ID1$83,夜光4-8,🌃💡83-105"
function cleanItems(value) {
  if (typeof value !== "string") return null;
  const items = canon(value).trim();   // the same songs with other skin tones are the same playlist
  const tokens = items.split(",");
  if (!items || items.length > 4000 || tokens.length > 100 || !tokens.every(t => ITEM_RE.test(t))) return null;
  return items;
}

async function getPlaylist({ url, request, env }) {
  if (!env.DB) return notSetUp();
  const id = String(url.searchParams.get("id") || "").toLowerCase();
  if (!PLAYLIST_ID_RE.test(id)) return json({ error: "That isn't a playlist link" }, 400);
  const row = await env.DB.prepare("SELECT * FROM playlists WHERE id = ?").bind(id).first();
  if (!row) return json({ error: "No playlist has this link" }, 404);
  return json(playlistReply(row, await signedIn(request, env), true));
}

async function suggestPlaylist({ body, request, env }) {
  if (!env.DB) return notSetUp();
  const db = env.DB;
  const items = cleanItems(body && body.items);
  if (!items) return json({ error: "Send the playlist's songs" }, 400);
  const hash = await fingerprint(items);
  const owner = await signedIn(request, env);

  // Already saved: your own copy when you're signed in, else the shared snapshot
  if (owner) {
    const own = await db.prepare("SELECT * FROM playlists WHERE owner = ? AND hash = ?").bind(owner, hash).first();
    if (own) return json(playlistReply(own, owner));
  }
  const snap = await db.prepare("SELECT * FROM playlists WHERE owner IS NULL AND hash = ?").bind(hash).first();
  if (snap && !owner) return json(playlistReply(snap, null));

  let labels, why = "", about = [];
  if (snap) {
    labels = describeLabels(JSON.parse(snap.labels));   // a signed-in copy of a snapshot starts with its labels
    why = snap.why || "";
    for (const k of LABELS) if (labels[k]) labels[k].saved = false;
  } else {
    if (!env.AI) return json({ error: "Code suggestions aren't set up on this Worker yet" }, 503);
    const songs = await songsFor(items, db);
    if (!songs.length) return json({ error: "Couldn't read these songs from Spotify. Try again in a moment." }, 502);
    about = songs.map(songLabel);
    const built = await askForCodes(env, songs, true, LABELS, await loadWords());
    labels = {};
    for (const k of LABELS) if (built[k].cands.length) labels[k] = { ...withOptions(built[k].cands[0], built[k], false), saved: false };
    if (!Object.keys(labels).length) return json({ error: "Couldn't come up with labels for this one. Try again." }, 502);
    why = (LABELS.map(k => labels[k] && labels[k].why).find(Boolean)) || "";
  }
  // The ID the link will have. A signed-in person's comes with a signature, so saving can keep
  // it without letting anyone pick their own (custom IDs are for paid links later).
  const id = await freshId(db, owner ? randomIds() : snapshotIds(items, hash));
  const reply = { id, labels, why, saved: false, mine: !!owner, owned: !!owner, about };
  if (owner) reply.idSig = await keyed(env, `pid:${owner}:${id}`);
  return json(reply);
}

async function savePlaylist({ body, request, env }) {
  if (!env.DB) return notSetUp();
  const db = env.DB;
  const owner = await signedIn(request, env);
  const items = cleanItems(body && body.items);
  if (!items) return json({ error: "Send the playlist's songs" }, 400);
  const hash = await fingerprint(items);
  const at = new Date().toISOString();

  // An owner changing their playlist: the songs (and labels, if sent) change, the link stays
  if (body.edit) {
    if (!owner) return json({ error: "Sign in to change your playlist" }, 401);
    const row = await db.prepare("SELECT * FROM playlists WHERE id = ?").bind(String(body.edit).toLowerCase()).first();
    if (!row) return json({ error: "No playlist has this link" }, 404);
    if (row.owner !== owner) return json({ error: "Only its owner can change this playlist" }, 403);
    const labels = body.labels ? cleanLabels(body.labels) : null;
    if (labels && labels.error) return json(labels, 400);
    await db.prepare("UPDATE playlists SET items = ?, hash = ?, labels = ?, why = ?, updated = ? WHERE id = ? AND owner = ?")
      .bind(items, hash, labels ? JSON.stringify(labels.stored) : row.labels, labels ? labels.why || row.why : row.why, at, row.id, owner).run();
    return json(playlistReply(await db.prepare("SELECT * FROM playlists WHERE id = ?").bind(row.id).first(), owner));
  }

  if (!(await allow(db, "save:" + (await ipKey(request, env)), 60, HOUR))) {
    return json({ error: "Too many playlists saved from here. Try again in a while." }, 429);
  }
  const labels = cleanLabels(body.labels);
  if (labels.error) return json(labels, 400);
  const row = { items, hash, labels: JSON.stringify(labels.stored), why: labels.why, created: at, updated: at };

  if (owner) {
    const own = await db.prepare("SELECT * FROM playlists WHERE owner = ? AND hash = ?").bind(owner, hash).first();
    if (own) return json(playlistReply(own, owner));
    const shown = typeof body.id === "string" && typeof body.idSig === "string"
      && sameText(body.idSig, await keyed(env, `pid:${owner}:${body.id}`)) ? [body.id] : [];
    const id = await insertPlaylist(db, { ...row, owner }, withFirst(shown, randomIds()));
    return json(playlistReply({ ...row, id, owner }, owner));
  }
  // A snapshot: first come, first served, like song codes
  const snap = await db.prepare("SELECT * FROM playlists WHERE owner IS NULL AND hash = ?").bind(hash).first();
  if (snap) return json(playlistReply(snap, null));
  const id = await insertPlaylist(db, { ...row, owner: null }, snapshotIds(items, hash));
  if (!id) {   // the same snapshot was saved a moment ago
    const again = await db.prepare("SELECT * FROM playlists WHERE owner IS NULL AND hash = ?").bind(hash).first();
    if (again) return json(playlistReply(again, null));
    throw new Error("Couldn't save the playlist");
  }
  return json(playlistReply({ ...row, id, owner: null }, null));
}

async function myPlaylists({ request, env }) {
  if (!env.DB) return notSetUp();
  const owner = await signedIn(request, env);
  if (!owner) return json({ error: "Sign in to see your playlists" }, 401);
  const rows = (await env.DB.prepare("SELECT * FROM playlists WHERE owner = ? ORDER BY updated DESC LIMIT 100").bind(owner).all()).results;
  return json({ playlists: rows.map(r => playlistReply(r, owner, true)) });
}

// Saves a playlist under the first free ID it's offered; returns the ID, or null when the
// same snapshot was saved a moment ago
async function insertPlaylist(db, row, ids) {
  for await (const id of ids) {
    try {
      await db.prepare("INSERT INTO playlists (id, items, hash, owner, labels, why, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(id, row.items, row.hash, row.owner, row.labels, row.why || "", row.created, row.updated).run();
      return id;
    } catch (err) {
      if (!isConflict(err)) throw err;
      if (row.owner === null) {
        const same = await db.prepare("SELECT id FROM playlists WHERE owner IS NULL AND hash = ?").bind(row.hash).first();
        if (same) return null;
      }
      // that ID belongs to another playlist: try the next one
    }
  }
  throw new Error("Couldn't find a free playlist ID");
}

// Snapshot IDs: the start of the playlist's fingerprint, one character longer each time it's
// taken, then the fingerprint of a variation. Starts that spell something rude are skipped.
async function* snapshotIds(items, hash) {
  let h = hash;
  for (let variation = 1; variation <= 20; variation++) {
    for (let len = 3; len <= 13; len++) {
      const id = withDigit(h.slice(0, len));
      if (!rude(id)) yield id;
    }
    h = await fingerprint(items + "\n" + variation);
  }
}

// Own playlists get random IDs: a few tries at each length before going one longer
function* randomIds() {
  for (let len = 3; len <= 13; len++) {
    for (let n = 0; n < (len < 13 ? 6 : 30); n++) {
      const id = withDigit(randomId(len));
      if (!rude(id)) yield id;
    }
  }
}

// An ID made only of letters gets its last letter turned into a digit (the same one each time)
function withDigit(id) {
  if (/[0-9]/.test(id)) return id;
  return id.slice(0, -1) + String(ID_ALPHABET.indexOf(id[id.length - 1]) % 10);
}

async function* withFirst(first, rest) {
  yield* first;
  yield* rest;
}

async function freshId(db, ids) {
  for await (const id of ids) {
    if (!(await db.prepare("SELECT 1 AS x FROM playlists WHERE id = ?").bind(id).first())) return id;
  }
  return null;
}

const rude = id => ID_BLOCK_RE.test(id);

// Labels as sent by the page -> { stored, why } or { error, kind }
function cleanLabels(given) {
  if (!given || typeof given !== "object") return { error: "Send the playlist's labels" };
  const stored = {};
  let why = "";
  for (const k of LABELS) {
    const g = given[k];
    if (!g || typeof g.code !== "string") continue;
    const code = k === "en" ? cleanEnglish(g.code) : k === "em" ? canon(g.code).replace(/\s+/g, "") : g.code.replace(/\s+/g, "");
    const p = problem(k, code);
    if (p) return { error: p, kind: k };
    if (k === "zh") {
      const chars = Array.isArray(g.chars) ? g.chars : [];
      stored.zh = { code, chars: [...code].map((ch, i) => ({ char: ch, meaning: text(chars[i] && chars[i].char === ch ? chars[i].meaning : "", 30) })) };
    } else {
      stored[k] = { code };
    }
    why = why || text(g.why, 90);
  }
  if (!Object.keys(stored).length) return { error: "Send at least one label" };
  return { stored, why };
}

function describeLabels(stored) {
  const out = {};
  for (const k of LABELS) {
    const s = stored && stored[k];
    if (!s || typeof s.code !== "string") continue;
    const chars = k === "zh" ? parseChars(JSON.stringify(s.chars || []), s.code)
      : k === "eg" ? [...s.code].map(glyphChar)
      : k === "em" ? [...s.code].map(emojiChar)
      : s.code.split("-").map(wordChar);
    out[k] = { code: s.code, chars, saved: true };
  }
  return out;
}

function playlistReply(row, owner, withItems) {
  const reply = {
    id: row.id,
    labels: describeLabels(typeof row.labels === "string" ? JSON.parse(row.labels) : row.labels),
    why: row.why || "",
    saved: true,
    mine: !!owner && row.owner === owner,
    owned: !!row.owner,
  };
  if (withItems) reply.items = row.items;
  return reply;
}

// ---- Accounts: email + a 6-digit code ----------------------------------------------------------

async function startSignIn({ body, request, env }) {
  if (!env.DB || !env.PEPPER || !env.RESEND_API_KEY) return json({ error: "Sign-in isn't set up on this Worker yet" }, 503);
  const db = env.DB;
  const email = cleanEmail(body && body.email);
  if (!email) return json({ error: "Enter a valid email address" }, 400);
  const who = await keyed(env, "email:" + email);
  const ip = await ipKey(request, env);
  // 3 codes per email per 15 minutes, 10 per connection per hour, 90 a day in all (Resend's free plan sends 100)
  if (!(await allow(db, "code:" + who, 3, 15 * MINUTE)) || !(await allow(db, "code-ip:" + ip, 10, HOUR))) {
    return json({ error: "Too many codes asked for. Wait a few minutes and try again." }, 429);
  }
  if (!(await allow(db, "code-all", 90, DAY))) {
    return json({ error: "Sign-in emails are paused for today. Try again tomorrow." }, 429);
  }
  const code = sixDigits();
  await db.prepare(`INSERT INTO sign_in_codes (email, code, expires, tries) VALUES (?, ?, ?, 0)
                    ON CONFLICT (email) DO UPDATE SET code = excluded.code, expires = excluded.expires, tries = 0`)
    .bind(who, await keyed(env, `code:${who}:${code}`), Date.now() + CODE_MINUTES * MINUTE).run();
  if (!(await sendCode(env, email, code))) return json({ error: "Couldn't send the email. Try again in a moment." }, 502);
  return json({ sent: true, minutes: CODE_MINUTES });
}

async function verifySignIn({ body, env }) {
  if (!env.DB || !env.PEPPER) return json({ error: "Sign-in isn't set up on this Worker yet" }, 503);
  const db = env.DB;
  const email = cleanEmail(body && body.email);
  const code = String((body && body.code) || "").replace(/\D/g, "");
  if (!email || code.length !== 6) return json({ error: "Enter the 6-digit code from the email" }, 400);
  const who = await keyed(env, "email:" + email);
  const row = await db.prepare("SELECT code, expires, tries FROM sign_in_codes WHERE email = ?").bind(who).first();
  if (!row || row.expires < Date.now()) return json({ error: "That code has expired. Ask for a new one.", expired: true }, 400);
  if (row.tries >= CODE_TRIES) return json({ error: "Too many wrong tries. Ask for a new code.", expired: true }, 429);
  const hashed = await keyed(env, `code:${who}:${code}`);
  if (!sameText(row.code, hashed)) {
    await db.prepare("UPDATE sign_in_codes SET tries = tries + 1 WHERE email = ?").bind(who).run();
    return json({ error: "That code isn't right", triesLeft: Math.max(0, CODE_TRIES - row.tries - 1) }, 400);
  }
  // The code works once: whoever removes it first is the one signed in
  const used = await db.prepare("DELETE FROM sign_in_codes WHERE email = ? AND code = ?").bind(who, hashed).run();
  if (!used.meta || used.meta.changes !== 1) return json({ error: "That code was just used. Ask for a new one.", expired: true }, 400);
  // The account is made the first time someone signs in with this email
  await db.prepare("INSERT INTO owners (id, email, created) VALUES (?, ?, ?) ON CONFLICT (email) DO NOTHING")
    .bind(randomId(16), who, new Date().toISOString()).run();
  const owner = await db.prepare("SELECT id FROM owners WHERE email = ?").bind(who).first();
  const token = randomToken();
  const expires = Date.now() + SESSION_DAYS * DAY;
  await db.prepare("INSERT INTO sessions (token, owner, expires) VALUES (?, ?, ?)").bind(await sha256hex(token), owner.id, expires).run();
  return json({ token, expires });
}

async function me({ request, env }) {
  if (!env.DB) return notSetUp();
  const owner = await signedIn(request, env);
  if (!owner) return json({ signedIn: false }, 401);
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM playlists WHERE owner = ?").bind(owner).first();
  return json({ signedIn: true, playlists: row ? row.n : 0 });
}

async function signOut({ request, env }) {
  if (!env.DB) return notSetUp();
  const token = bearer(request);
  if (token) await env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(await sha256hex(token)).run();
  return json({ signedOut: true });
}

// The account behind this request's sign-in, or null
async function signedIn(request, env) {
  const token = bearer(request);
  if (!token || !env.DB) return null;
  const row = await env.DB.prepare("SELECT owner, expires FROM sessions WHERE token = ?").bind(await sha256hex(token)).first();
  return row && row.expires > Date.now() ? row.owner : null;
}

function bearer(request) {
  const m = (request.headers.get("Authorization") || "").match(/^Bearer\s+([A-Za-z0-9_-]{20,100})$/);
  return m ? m[1] : null;
}

async function sendCode(env, email, code) {
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: env.EMAIL_FROM || FROM,
        to: [email],
        subject: `Your Spotiky code: ${code}`,
        text: `Your Spotiky sign-in code is ${code}\n\nIt works for ${CODE_MINUTES} minutes. If you didn't ask for it, you can ignore this email.`,
      }),
    });
    if (!res.ok) {
      // Resend's reason, for the Worker's logs (npx wrangler tail). Only the kind of error: its
      // message can include the email address, and emails are never kept.
      const why = await res.json().catch(() => ({}));
      console.log(`Resend didn't send a sign-in code: ${res.status} ${why.name || ""}`.trim());
    }
    return res.ok;
  } catch (err) {
    console.log("Couldn't reach Resend: " + (err && err.message));
    return false;
  }
}

function cleanEmail(value) {
  const e = String(value || "").trim().toLowerCase();
  return e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
}

// Rate limits: allows `limit` events per `windowMs` for a key, counting this one
async function allow(db, key, limit, windowMs) {
  const now = Date.now();
  const row = await db.prepare("SELECT COUNT(*) AS n FROM sends WHERE key = ? AND at > ?").bind(key, now - windowMs).first();
  if (row && row.n >= limit) return false;
  await db.prepare("INSERT INTO sends (key, at) VALUES (?, ?)").bind(key, now).run();
  if (Math.random() < 0.02) await db.prepare("DELETE FROM sends WHERE at < ?").bind(now - 2 * DAY).run();
  return true;
}

// Where a request comes from, hashed so no IP address is ever stored
const ipKey = (request, env) => keyed(env, "ip:" + (request.headers.get("CF-Connecting-IP") || "unknown"));

// ---- Song details ------------------------------------------------------------------------

// Up to 8 songs to describe: a song ID, or a playlist's songs (codes looked up)
async function songsFor(itemsOrId, db) {
  const ids = [];
  for (const token of String(itemsOrId).split(",")) {
    if (ids.length >= 8) break;
    const id = token.slice(0, 22);
    if (ID_RE.test(id)) { ids.push(id); continue; }
    const row = await db.prepare("SELECT track FROM song_codes WHERE code = ?").bind(canon(token.replace(/[\d-]+$/, ""))).first();
    if (row) ids.push(row.track);
  }
  return (await Promise.all(ids.map(songInfo))).filter(Boolean);
}

// A song's title and artists. The title comes from Spotify's oEmbed API (the embed page
// stopped carrying a <title>); the artists come from the embed page.
async function songInfo(id) {
  const [oembed, html] = await Promise.all([oembedTitle(id), embedPage(id)]);
  const title = oembed || (html && titleIn(html));
  return title ? { title, artist: (html && artistsIn(html)) || null } : null;
}

async function oembedTitle(id) {
  try {
    const page = encodeURIComponent(`https://open.spotify.com/track/${id}`);
    const res = await fetch(`https://open.spotify.com/oembed?url=${page}`, { headers: { "User-Agent": UA } });
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data.title === "string" && data.title.trim() ? data.title.trim() : null;
  } catch (err) {
    return null;
  }
}

// The public embed page: it carries the preview MP3 and the artists
async function embedPage(id) {
  try {
    const res = await fetch(`https://open.spotify.com/embed/track/${id}`, { headers: { "User-Agent": UA } });
    return res.ok ? await res.text() : null;
  } catch (err) {
    return null;
  }
}

// The title on an embed page, for when oEmbed doesn't answer
function titleIn(html) {
  for (const m of [
    html.match(/<title[^>]*>([^<]+)<\/title>/),
    html.match(/<h1\b[^>]*>(?:\s*<[^>]+>)*\s*([^<]+)</),
    html.match(/<img\b[^>]*\balt="([^"]+?) cover"/),
  ]) {
    if (!m) continue;
    const t = entities(m[1]).replace(/\s*\|\s*Spotify\s*$/i, "").replace(/\s+-\s+song(?: and lyrics)? by\s+.+$/i, "").trim();
    if (t && !/^spotify(?: embed)?$/i.test(t)) return t;
  }
  return null;
}

// Up to three artist names from an embed page: its data's "artists" list, else its artist links
function artistsIn(html) {
  const names = [];
  const add = n => { n = (n || "").trim(); if (n && !names.includes(n) && names.length < 3) names.push(n); };
  const list = html.match(/"artists":\s*\[([^\]]*)\]/);
  if (list) for (const m of list[1].matchAll(/"name":\s*"((?:[^"\\]|\\.)*)"/g)) add(unjson(m[1]));
  if (!names.length) {
    for (const m of html.matchAll(/<a\b[^>]*\bhref="[^"]*\/artist\/[A-Za-z0-9]{22}[^"]*"[^>]*>(?:\s*<[^>]+>)*\s*([^<]+)</g)) add(entities(m[1]));
  }
  if (!names.length) {
    const t = html.match(/<title[^>]*>[^<]*?\s-\s+song(?: and lyrics)? by\s+([^<|]+)/i);
    if (t) add(entities(t[1]));
  }
  return names.length ? names.join(", ") : null;
}

const songLabel = s => `"${s.title}"` + (s.artist ? ` by ${s.artist}` : "");

const unjson = s => { try { return JSON.parse(`"${s}"`); } catch (err) { return s; } };

function entities(s) {
  const cp = n => (n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "");
  return s.replace(/&#x([0-9a-f]+);/gi, (_, h) => cp(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => cp(Number(d)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
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

// ---- Previews ----------------------------------------------------------------------------

async function preview(url) {
  const trackId = url.searchParams.get("id");

  if (!trackId || !/^[a-zA-Z0-9]{22}$/.test(trackId)) {
    return json({ error: "Missing or invalid track id" }, 400);
  }

  try {
    const [title, html] = await Promise.all([oembedTitle(trackId), embedPage(trackId)]);
    if (html == null && !title) {
      return json({ error: "Could not load embed page" }, 502);
    }

    let previewUrl = null;
    if (html) {
      const match1 = html.match(/https:\/\/p\.scdn\.co\/mp3-preview\/[a-zA-Z0-9]+/);
      if (match1) previewUrl = match1[0];

      if (!previewUrl) {
        const nextDataMatch = html.match(/"audioPreview":\s*{\s*"url":\s*"([^"]+)"/);
        if (nextDataMatch) previewUrl = nextDataMatch[1];
      }
    }

    return json({
      preview_url: previewUrl,
      name: title || (html && titleIn(html)) || null,
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

const isConflict = err => /UNIQUE|constraint/i.test(String(err && err.message));

function base32(bytes) {
  let out = "", n = 0, bits = 0;
  for (const b of bytes) {
    n = (n << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ID_ALPHABET[(n >> bits) & 31];
    }
    n &= (1 << bits) - 1;
  }
  return bits ? out + ID_ALPHABET[(n << (5 - bits)) & 31] : out;
}

// A playlist's fingerprint: SHA-256 of its songs, written with the 32 ID characters
async function fingerprint(s) {
  return base32(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))));
}

async function sha256hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

// HMAC with the PEPPER secret, so stored hashes are useless without it
let hmacKey = null, hmacFor = null;
async function keyed(env, s) {
  if (!env.PEPPER) return sha256hex(s);   // only rate-limit keys get here; accounts require the pepper
  if (hmacFor !== env.PEPPER) {
    hmacKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.PEPPER), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    hmacFor = env.PEPPER;
  }
  const sig = await crypto.subtle.sign("HMAC", hmacKey, new TextEncoder().encode(s));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomId(len) {
  return [...crypto.getRandomValues(new Uint8Array(len))].map(b => ID_ALPHABET[b & 31]).join("");
}

function sixDigits() {
  const limit = 4294000000;   // the largest multiple of a million below 2^32, so every code is equally likely
  let n;
  do { n = crypto.getRandomValues(new Uint32Array(1))[0]; } while (n >= limit);
  return String(n % 1000000).padStart(6, "0");
}

function sameText(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
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
