// 中南大学 拾光课程表适配脚本
// 教务：强智 jsxsd（与 CSUFT 同厂，但页面结构不同，不可照抄）
// 入口：统一身份认证登录后自动跳入教务，用户看到 …/jsxsd/… 再点导入。
//       脚本不代传账号密码，只在已登录的教务页内抓取课表。
//
// 三个必须注意的页面特征：
//   ① 表头列序为「星期日、星期一…」，星期日在第 0 列，需映射为 day=7
//   ② 节次表头是全角连字符「1－2」，用 /\d+/g 取数字
//   ③ 格内 kbcontent1 是隐藏旧数据，必须精确匹配 class="kbcontent"，否则课程翻倍

// 兜底基址；实际主机由 resolveBaseUrl() 按当前页 origin 决定
const BASE_URL = "http://csujwc.its.csu.edu.cn";

const JSXSD_KB_PATH = "/jsxsd/xskb/xskb_list.do";

// 该校按学号把请求分摊到多台服务器（csujwc / csujwc2 …），故按后缀匹配
const JW_HOST_SUFFIX = '.its.csu.edu.cn';

/**
 * 当前页是否已在教务系统内。
 * 判据二选一：路径含 /jsxsd/，或主机属教务域 —— 因为同源策略只认 origin，
 * 与路径无关；写死 BASE_URL 在会话被分摊到别的主机时会跨域失败。
 */
function isOnJsxsdPage() {
    try {
        if (typeof location === 'undefined' || !location.href) return false;
        const href = String(location.href);
        if (/\/jsxsd(\/|$|\?)/i.test(href)) return true;
        const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(href);
        if (m && m[1].toLowerCase().endsWith(JW_HOST_SUFFIX)) return true;
        return false;
    } catch (e) {
        return false;
    }
}

function resolveBaseUrl() {
    if (isOnJsxsdPage()) {
        try {
            return location.origin;
        } catch (e) { /* 受限，忽略，走兜底 */ }
    }
    return BASE_URL;
}

/** 课表接口的完整 URL */
function kbUrl() {
    return resolveBaseUrl() + JSXSD_KB_PATH;
}

const WEEKDAY_MAP = {
    '星期一': 1, '星期二': 2, '星期三': 3, '星期四': 4,
    '星期五': 5, '星期六': 6, '星期日': 7, '星期天': 7
};

// 中南作息：校历「上课时间」，2024-2025 起三学年一致，共 10 节。
// 第九节前 17:40-19:00 为晚餐不排课，故第九节不接第八节。
const TIME_SLOTS = [
    { number: 1, startTime: "08:00", endTime: "08:45" },
    { number: 2, startTime: "08:55", endTime: "09:40" },
    { number: 3, startTime: "10:00", endTime: "10:45" },
    { number: 4, startTime: "10:55", endTime: "11:40" },
    { number: 5, startTime: "14:00", endTime: "14:45" },
    { number: 6, startTime: "14:55", endTime: "15:40" },
    { number: 7, startTime: "16:00", endTime: "16:45" },
    { number: 8, startTime: "16:55", endTime: "17:40" },
    { number: 9, startTime: "19:00", endTime: "19:45" },
    { number: 10, startTime: "19:55", endTime: "20:40" }
];

// ===================== 字符串解析工具（不依赖 DOM，便于 Node 下测试） =====================

function unescapeHtml(s) {
    return s
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&#(\d+);/g, function (_, n) { return String.fromCharCode(parseInt(n, 10)); })
        .replace(/&[a-z]+;/gi, ' ');
}

// 按标签深度平衡截取 table，避免嵌套 table 被误切
function findTable(html, tableId) {
    const re = new RegExp('<table[^>]*id=["\']' + tableId + '["\'][^>]*>', 'i');
    const m = re.exec(html);
    if (!m) return null;
    const i = m.index;
    let depth = 0;
    const tagRe = /<(\/?)table\b[^>]*>/gi;
    tagRe.lastIndex = i;
    let mm;
    while ((mm = tagRe.exec(html)) !== null) {
        if (mm[1] === '') depth++;
        else {
            depth--;
            if (depth === 0) return html.slice(i, mm.index + mm[0].length);
        }
    }
    return null;
}

function stripTags(s) {
    s = s.replace(/<br\s*\/?>/gi, '\n');
    s = s.replace(/<[^>]+>/g, '');
    return unescapeHtml(s).replace(/ /g, ' ').trim();
}

// '1－2' / '第5,6节' → [start, end]，取前两个数字
function parseSections(thText) {
    const txt = stripTags(thText);
    const nums = txt.match(/\d+/g);
    if (!nums) return null;
    if (nums.length >= 2) return [parseInt(nums[0], 10), parseInt(nums[1], 10)];
    return [parseInt(nums[0], 10), parseInt(nums[0], 10)];
}

// 周次：'3-12(周)' / '1,3,5(周)' / '2-4,8-20双周'
// 单双标记有 (单)/(双)/(单周)/(双周)/裸「双周」等形态
function parseWeeks(weekStr) {
    const weeks = [];
    if (!weekStr) return weeks;

    let odd = false, even = false;
    // 括号整段摘掉，避免标记残留在数字段
    let rest = String(weekStr).replace(/[（(][^）)]*[）)]/g, '');
    // 单双只看括号内，避免课程名里的「双」字被误判
    if (/[（(][^）)]*单[^）)]*[）)]/.test(weekStr)) odd = true;
    if (/[（(][^）)]*双[^）)]*[）)]/.test(weekStr)) even = true;
    // 裸标记须在提数字前剥离，否则 '8-20双周' 的「双」会粘住区间尾部
    rest = rest.replace(/单周|双周/g, '').replace(/周|第/g, '');
    if (!odd && !even) {
        if (/单周/.test(weekStr)) odd = true;
        if (/双周/.test(weekStr)) even = true;
    }
    rest = rest.replace(/[^\d\-－~～,，]/g, '');   // 容忍 '3-12(周)abc' 这类脏数据

    for (let seg of rest.split(/[,，]/)) {
        seg = seg.trim();
        if (!seg) continue;
        const m = /^(\d+)\s*[-－~～]\s*(\d+)$/.exec(seg);
        if (m) {
            const s = parseInt(m[1], 10), e = parseInt(m[2], 10);
            if (e >= s) for (let i = s; i <= e; i++) weeks.push(i);
            else weeks.push(s); // 倒序区间
        } else {
            const mm = /\d+/.exec(seg);
            if (mm) weeks.push(parseInt(mm[0], 10));
        }
    }
    let result = Array.from(new Set(weeks)).sort((a, b) => a - b);
    // 单双同时出现时不过滤，无法判定按哪个走，宁可多留不要丢课
    if (odd && !even) result = result.filter(w => w % 2 === 1);
    else if (even && !odd) result = result.filter(w => w % 2 === 0);
    return result;
}

// '贺福利[副教授]' → '贺福利'
function cleanTeacher(s) {
    s = s.replace(/[\[【][^\]】]*[\]】]/g, '');
    return s.trim();
}

// 解析单个 kbcontent 块 → [课程名, 教师, 教室, 周次原文]
function parseKbContent(block) {
    let body = block.replace(/^<div[^>]*>/i, '');
    body = body.replace(/<\/div>\s*$/i, '');
    // 拼课切分后第 2 段起以 <br> 开头，须先剥掉，否则课程名取不到而整段被丢
    body = body.replace(/^(?:\s*<br\s*\/?>)+/i, '');

    function fontOf() {
        const titles = Array.prototype.slice.call(arguments);
        const pat = new RegExp('<font[^>]*title=["\'](?:' + titles.join('|') + ')["\'][^>]*>(.*?)</font>', 'i');
        const mm = pat.exec(body);
        return mm ? stripTags(mm[1]) : '';
    }

    const teacher = fontOf('老师', '教师');
    const position = fontOf('教室', '上课地点');
    const weeksRaw = fontOf('周次\\(节次\\)', '周次', '节次');

    // 部分页面的单双周是独立字段，需并入周次串统一处理
    const singleDouble = fontOf('单双周');
    const weeksTxt = (weeksRaw && /单|双/.test(singleDouble))
        ? weeksRaw + singleDouble
        : weeksRaw;

    const m = /^\s*([^<]+)/.exec(body);
    let name = m ? unescapeHtml(m[1]).replace(/ /g, ' ').trim() : '';
    if (!name) {
        name = stripTags(body.replace(/<br\s*\/?>.*$/is, ''));
    }
    return [name, cleanTeacher(teacher), position, weeksTxt];
}

/**
 * 取出 class 精确等于 kbcontent 的 div 内部 HTML。
 * 必须先截出这个 div 再在内部切分：kbcontent1 排在前面且内部同样有拼课横线，
 * 若先切 td 则第二片起匹配不到 div 开头，会丢掉另一条课。
 */
function extractKbContentInner(td) {
    const m = /<div[^>]*class=["']kbcontent["'][^>]*>/i.exec(td);
    if (!m) return null;
    const start = m.index + m[0].length;
    let depth = 1;
    const re = /<(\/?)div\b[^>]*>/gi;
    re.lastIndex = start;
    let mm;
    while ((mm = re.exec(td)) !== null) {
        if (mm[1] === '') {
            depth++;
        } else {
            depth--;
            if (depth === 0) return td.slice(start, mm.index);
        }
    }
    return td.slice(start);
}

// 主解析：整页 HTML → 合并后的课程数组
function parseSchedule(html) {
    const table = findTable(html, 'kbtable');
    if (!table) return [];
    const rows = table.match(/<tr[^>]*>.*?<\/tr>/gis) || [];
    const colToDay = {};
    const raw = [];

    for (const row of rows) {
        const ths = [];
        let tm;
        const thRe = /<th[^>]*>(.*?)<\/th>/gis;
        while ((tm = thRe.exec(row)) !== null) ths.push(stripTags(tm[1]));

        const tds = [];
        let dm;
        const tdRe = /<td[^>]*>(.*?)<\/td>/gis;
        while ((dm = tdRe.exec(row)) !== null) tds.push(dm[1]);

        // 表头行：任一 th 含「星期」
        if (ths.some(t => t.indexOf('星期') >= 0)) {
            ths.forEach((cname, ci) => {
                if (ci === 0) return; // 第 0 列是节次标签列
                for (const k in WEEKDAY_MAP) {
                    if (cname.indexOf(k) >= 0) {
                        colToDay[ci - 1] = WEEKDAY_MAP[k]; // td 索引从 0 起
                        break;
                    }
                }
            });
            continue;
        }

        const section = ths.length ? parseSections(ths[0]) : null;
        if (!section) continue;

        tds.forEach((td, ci) => {
            const day = colToDay[ci];
            if (day === undefined) return;
            const inner = extractKbContentInner(td);
            if (inner === null) return;
            // 同格拼课以纯文本横线分隔，被 <br> 夹住。
            // 两块共用本格节次范围、靠周次区分先后，绝不能拆成不同节次，
            // 否则同一门课会在学期中途跳节。
            const blocks = inner.split(/-{5,}/);
            for (const seg of blocks) {
                const [name, teacher, position, weeksTxt] = parseKbContent(seg);
                if (!name || name.length < 2) continue;
                raw.push({
                    name: name, teacher: teacher, position: position,
                    day: day, startSection: section[0], endSection: section[1],
                    weeksRaw: weeksTxt, weeks: parseWeeks(weeksTxt)
                });
            }
        });
    }
    return mergeCourses(raw);
}

// 阶段 1 合并连排课（周次须相同，否则分阶段排课会被错并），阶段 2 合并同节次的周次
function mergeCourses(courses) {
    if (!Array.isArray(courses) || courses.length <= 1) return courses;

    const sameKey = (a, b) =>
        a.name === b.name && a.teacher === b.teacher &&
        a.position === b.position && a.day === b.day;
    const weeksKey = c => (Array.isArray(c.weeks) ? c.weeks.join(',') : '');
    const bySection = (a, b) =>
        (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) ||
        (a.teacher < b.teacher ? -1 : a.teacher > b.teacher ? 1 : 0) ||
        (a.position < b.position ? -1 : a.position > b.position ? 1 : 0) ||
        (a.day || 0) - (b.day || 0) ||
        (a.startSection || 0) - (b.startSection || 0) ||
        (a.endSection || 0) - (b.endSection || 0);

    const list = courses.map(c => ({
        ...c,
        name: c.name || '',
        teacher: c.teacher || '',
        position: c.position || '',
        weeks: Array.isArray(c.weeks) ? c.weeks.slice().sort((a, b) => a - b) : []
    }));

    list.sort((a, b) => bySection(a, b) || weeksKey(a).localeCompare(weeksKey(b)));
    const step1 = [];
    let cur = list[0];
    for (let i = 1; i < list.length; i++) {
        const next = list[i];
        const isSameCourse = sameKey(cur, next) && weeksKey(cur) === weeksKey(next);
        if (isSameCourse && next.startSection === cur.endSection + 1) {
            cur.endSection = next.endSection;
        } else if (isSameCourse && next.startSection === cur.startSection &&
                   next.endSection === cur.endSection) {
            continue;
        } else {
            step1.push(cur);
            cur = next;
        }
    }
    step1.push(cur);

    step1.sort(bySection);
    const out = [];
    cur = step1[0];
    for (let i = 1; i < step1.length; i++) {
        const next = step1[i];
        if (sameKey(cur, next) &&
            cur.startSection === next.startSection && cur.endSection === next.endSection) {
            cur.weeks = Array.from(new Set(cur.weeks.concat(next.weeks))).sort((a, b) => a - b);
        } else {
            out.push(cur);
            cur = next;
        }
    }
    out.push(cur);

    return out;
}

// 从 <select id="xnxq01id"> 取学期选项 → [{value, text}]
function parseSemesterOptions(html) {
    const options = [];
    const sm = /<select[^>]*id=["']xnxq01id["'][^>]*>(.*?)<\/select>/is.exec(html);
    if (!sm) return options;
    const inner = sm[1];
    let om;
    const optRe = /<option[^>]*value=["']([^"']*)["'][^>]*>(.*?)<\/option>/gis;
    while ((om = optRe.exec(inner)) !== null) {
        options.push({ value: om[1], text: stripTags(om[2]) });
    }
    return options;
}

// 由 xnxq01id（如 2026-2027-1）估算开学日：1=当年 9 月首个周一，2=次年 2 月首个周一。
// 仅估算，导入前会弹框让用户按校历修正。
function guessSemesterStartDate(semId) {
    const m = /^(\d{4})-(\d{4})-(\d)$/.exec(semId || '');
    if (!m) return null;
    const startYear = parseInt(m[1], 10);
    const term = parseInt(m[3], 10);
    let year, month;
    if (term === 1) { year = startYear; month = 9; }
    else { year = startYear + 1; month = 2; }
    const d = new Date(year, month - 1, 1);
    const dow = d.getDay(); // 0=周日
    const offset = (dow === 1) ? 0 : (dow === 0 ? 1 : 8 - dow);
    d.setDate(d.getDate() + offset);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${mm}-${dd}`;
}

// 供 showPrompt 按名调用的校验函数，返回字符串为错误提示，false 为通过
function validateDateInput(input) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input)) return "请输入正确的日期格式：YYYY-MM-DD";
    return false;
}

// ===================== 导入流程 =====================

async function fetchHtml(url, method, body) {
    const resp = await fetch(url, {
        method: method || "GET",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body || null,
        credentials: "include"
    });
    return await resp.text();
}

async function runImportFlow() {
    try {
        // 必须停在教务页：fetch 受同源限制，跳到别的页面会被 CORS 拦掉
        const inJsxsd = isOnJsxsdPage();
        const confirmed = await window.shiguangBridgePromise.showAlert(
            "导入前确认",
            inJsxsd
                ? "检测到当前已在教务系统页面。请确认已登录，然后继续导入。"
                : "请先在本页完成统一身份认证（ca.csu.edu.cn）登录：\n"
                  + "登录成功后会自动跳转进入教务系统，地址变成 …/jsxsd/…，\n"
                  + "看到教务页面后再点「执行导入」即可，不用自己找课表入口。\n\n"
                  + "为什么要等跳转：脚本靠 fetch 读教务页面，浏览器要求同源，\n"
                  + "跨站直接请求会被拦截。\n\n"
                  + "仍要继续尝试吗？",
            "开始导入");
        if (!confirmed) return;

        window.shiguangBridge.showToast("正在读取学期列表…");

        let listHtml;
        try {
            listHtml = await fetchHtml(kbUrl(), "GET", null);
        } catch (err) {
            window.shiguangBridge.showToast("请求教务失败：" + ((err && err.message) ? err.message : err)
                + "。请确认地址已进入 …/jsxsd/… 并且已登录。");
            return;
        }
        // sso.jsp 期间抢点导入会拿到登录页，此处须拦住，避免存入空课表
        if (!findTable(listHtml, 'kbtable')) {
            window.shiguangBridge.showToast("没读到课表页（请求发往 " + resolveBaseUrl()
                + "）。多半是尚未登录，或页面还没跳转进教务系统，请登录后重试。");
            return;
        }

        const options = parseSemesterOptions(listHtml);
        if (options.length === 0) {
            window.shiguangBridge.showToast("未找到学期选项，请刷新页面后重试。");
            return;
        }

        const selIdx = await window.shiguangBridgePromise.showSingleSelection(
            "选择学期", JSON.stringify(options.map(o => o.text)), -1);
        if (selIdx === null) return;

        const semId = options[selIdx].value;

        let semesterStartDate = guessSemesterStartDate(semId);
        const dateInput = await window.shiguangBridgePromise.showPrompt(
            "开学日期",
            "请输入本学期开学日期(YYYY-MM-DD)，用于计算周次：",
            semesterStartDate || "",
            "validateDateInput");
        if (dateInput != null && dateInput !== "null" && /^\d{4}-\d{2}-\d{2}$/.test(dateInput)) {
            semesterStartDate = dateInput;
        }

        window.shiguangBridge.showToast("正在导入课表…");

        const html = await fetchHtml(
            kbUrl(), "POST", "xnxq01id=" + encodeURIComponent(semId));

        const courses = parseSchedule(html);
        if (courses.length === 0) {
            window.shiguangBridge.showToast("未找到课程，请检查学期选择或登录状态。");
            return;
        }

        await window.shiguangBridgePromise.saveCourseConfig(JSON.stringify({
            semesterStartDate: semesterStartDate,
            semesterTotalWeeks: 20,
            firstDayOfWeek: 1
        }));
        await window.shiguangBridgePromise.savePresetTimeSlots(JSON.stringify(TIME_SLOTS));
        await window.shiguangBridgePromise.saveImportedCourses(JSON.stringify(courses.map(c => ({
            name: c.name,
            teacher: c.teacher,
            position: c.position,
            day: c.day,
            startSection: c.startSection,
            endSection: c.endSection,
            weeks: c.weeks
        }))));

        window.shiguangBridge.showToast("成功导入 " + courses.length + " 门课程");
        window.shiguangBridge.notifyTaskCompletion();
    } catch (err) {
        window.shiguangBridge.showToast("错误: " + (err && err.message ? err.message : err));
    }
}

// 入口：WebView 中桥接就绪即执行
if (typeof window !== 'undefined' && window.shiguangBridgePromise) {
    runImportFlow();
}

// Node 下只导出函数供测试，浏览器中不存在 module
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        parseSchedule, findTable, parseWeeks, parseSections, parseKbContent,
        mergeCourses, parseSemesterOptions, guessSemesterStartDate, stripTags
    };
}
