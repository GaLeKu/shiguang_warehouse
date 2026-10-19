// 中南大学 拾光课程表适配脚本
// 教务：强智 jsxsd（与 CSUFT 同厂，但页面结构不同，不可照抄）
// 入口：统一身份认证登录后进入教务系统，在课表页（或含课表的桌面页）点导入。
//       优先直接读当前页面 DOM——用户手动切过的学期只存在于页面里，
//       自己发请求只会拿回服务端的默认学期。当前页读不到时才退回发请求。
//
// 四个必须注意的页面特征：
//   ① 表头列序为「星期日、星期一…」，星期日在第 0 列，需映射为 day=7
//   ② 节次表头是全角连字符「1－2」，用 /\d+/g 取数字
//   ③ 格内 kbcontent1 是隐藏旧数据，查询必须精确写 div.kbcontent，否则课程翻倍
//   ④ 页面有两个 id=kbtable 的表，第二个是页脚周次表，开学日期与总周次从那里读
//
// 整体包在 IIFE 里：App 每次点「执行导入」都会把本文件整个重新 evaluate 一次，
// 顶层若直接写 const/function，第二次会抛 "Identifier 'KB_PATH' has already been
// declared" —— 脚本在进入 runImportFlow 之前就崩了，点第二次毫无反应。

(function () {

const KB_PATH = "/jsxsd/xskb/xskb_list.do";

// 该校按学号把请求分摊到多台服务器（csujwc / csujwc2 …），故按后缀匹配
const JW_HOST_SUFFIX = '.its.csu.edu.cn';

function isOnJwHost() {
    try {
        if (typeof location === 'undefined' || !location.href) return false;
        const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(String(location.href));
        return !!m && m[1].toLowerCase().endsWith(JW_HOST_SUFFIX);
    } catch (e) {
        return false;
    }
}

/**
 * 当前页是否带课表。
 * 不限具体路径：登录后的「我的桌面」等页面右侧也嵌了课表，同样直接读，
 * 这样页面显示的是哪个学期就导哪个学期。
 */
function pageHasSchedule() {
    try {
        return !!findCourseTable(document);
    } catch (e) {
        return false;
    }
}

/** 当前页是否在教务域内且没有课表 —— 此时才允许发同源请求兜底 */
function needFetchFallback() {
    return !pageHasSchedule() && isOnJwHost();
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

// ===================== DOM 解析 =====================

function parseDoc(html) {
    return new DOMParser().parseFromString(html, 'text/html');
}

// 该页有两个 id=kbtable 的表：第一个是课程格子，第二个是页脚的周次表。
// getElementById 只返回第一个，故这里按「含星期表头」筛出课程表。
function findCourseTable(doc) {
    const tables = doc.querySelectorAll('table');
    for (const t of tables) {
        if (t.getAttribute('id') !== 'kbtable') continue;
        const head = t.querySelector('tr');
        if (head && /星期/.test(head.textContent)) return t;
    }
    return null;
}

// '1－2' / '第5,6节' → [start, end]，取前两个数字
function parseSections(thText) {
    const nums = String(thText).match(/\d+/g);
    if (!nums) return null;
    if (nums.length >= 2) return [parseInt(nums[0], 10), parseInt(nums[1], 10)];
    return [parseInt(nums[0], 10), parseInt(nums[0], 10)];
}

// 周次：'3-12(周)' / '1,3,5(周)' / '2-4,8-20双周' / '3-12(周)[01-02节]'
// 单双标记有 (单)/(双)/(单周)/(双周)/裸「双周」等形态
function parseWeeks(weekStr) {
    const weeks = [];
    if (!weekStr) return weeks;

    let odd = false, even = false;
    // 圆括号与方括号整段摘掉。方括号里是节次（如 '[01-02节]'），
    // 不摘的话数字会粘成 '3-1201-02' 导致区间匹配失败、只剩第 3 周
    let rest = String(weekStr)
        .replace(/[（(][^）)]*[）)]/g, '')
        .replace(/[\[【][^\]】]*[\]】]/g, '');
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
    return String(s).replace(/[\[【][^\]】]*[\]】]/g, '').trim();
}

// 解析 kbcontent 内的拼课块 → [[课程名, 教师, 教室, 周次原文], ...]
// 拼课以 5 个以上连字符分隔，分隔符落在 <br> 之后的文本节点里。
// 教师/教室/周次以 font 元素给出，每段各占一组（老师、周次、教室），
// 故边走边收集：遇到分隔符就结算当前段，该段自带的 font 归它自己。
function parseKbContent(div) {
    const parts = [];
    let buf = '';
    let fonts = [];
    for (const node of div.childNodes) {
        if (node.nodeType === 3) {
            const chunks = node.textContent.split(/-{5,}/);
            for (let i = 0; i < chunks.length; i++) {
                if (i > 0) { parts.push({ text: buf, fonts }); buf = ''; fonts = []; }
                buf += chunks[i];
            }
        } else if (node.tagName === 'BR') {
            buf += '\n';
        } else if (node.tagName === 'FONT') {
            fonts.push({
                title: node.getAttribute('title') || '',
                text: node.textContent.trim()
            });
            buf += node.textContent;
        } else {
            buf += node.textContent;
        }
    }
    parts.push({ text: buf, fonts });

    const out = [];
    for (const part of parts) {
        // 课程名 = 首个换行之前的非空文本行。
        // 拼课第 2 段起以 <br> 开头，首个换行之前是空的，要往后找
        let name = '';
        for (const line of part.text.split('\n')) {
            const t = line.replace(/\s+/g, ' ').trim();
            if (t.length >= 2) { name = t; break; }
        }
        if (!name) continue;

        const pick = (titles) => {
            for (const t of titles) {
                const hit = part.fonts.find(f => f.title === t);
                if (hit) return hit.text;
            }
            return '';
        };
        const teacher = cleanTeacher(pick(['老师', '教师']));
        const position = pick(['教室', '上课地点']);
        let weeks = pick(['周次(节次)', '周次', '节次']);
        const sd = pick(['单双周']);
        // 部分页面的单双周是独立字段，需并入周次串统一处理
        if (weeks && /单|双/.test(sd)) weeks += sd;
        out.push([name, teacher, position, weeks]);
    }
    return out;
}

// 主解析：课表页 → 合并后的课程数组。
// 参数可以是 HTML 字符串，也可以是已 parseDoc 过的 document（nodeType 9），避免同一页重复解析
function parseSchedule(input) {
    const doc = (input && input.nodeType === 9) ? input : parseDoc(input);
    const table = findCourseTable(doc);
    if (!table) return [];

    const colToDay = {};
    const raw = [];

    for (const row of table.querySelectorAll('tr')) {
        const ths = Array.from(row.querySelectorAll('th'));
        const tds = Array.from(row.querySelectorAll('td'));

        // 表头行：任一 th 含「星期」
        if (ths.some(th => th.textContent.indexOf('星期') >= 0)) {
            ths.forEach((th, ci) => {
                if (ci === 0) return; // 第 0 列是节次标签列
                const cname = th.textContent;
                for (const k in WEEKDAY_MAP) {
                    if (cname.indexOf(k) >= 0) {
                        colToDay[ci - 1] = WEEKDAY_MAP[k]; // td 索引从 0 起
                        break;
                    }
                }
            });
            continue;
        }

        const section = ths.length ? parseSections(ths[0].textContent) : null;
        if (!section) continue;

        tds.forEach((td, ci) => {
            const day = colToDay[ci];
            if (day === undefined) return;
            // 必须精确取 class="kbcontent"：隐藏的 kbcontent1 带着同样完整的
            // 拼课数据，用模糊选择器会把每门课翻倍
            const div = td.querySelector('div.kbcontent');
            if (!div) return;
            // 同格拼课共用本格节次范围、靠周次区分先后，绝不能拆成不同节次
            for (const [name, teacher, position, weeksTxt] of parseKbContent(div)) {
                raw.push({
                    name, teacher, position,
                    day, startSection: section[0], endSection: section[1],
                    weeksRaw: weeksTxt, weeks: parseWeeks(weeksTxt)
                });
            }
        });
    }
    return mergeCourses(raw);
}

// 教务的周次表按「周日~周六」分周（如第1周 2026-09-06(日)~09-12(六)），
// 而 App 的 firstDayOfWeek=1 要求开学日期是该周周一。
// 直接把周日填进去会让整张课表前移一周（周四落到 09-03 而非 09-10），
// 故统一推到该周的周一再交给 App。
function toWeekMonday(dateStr) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
    if (!m) return dateStr;
    const d = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
    const wd = d.getDay();          // 0=周日
    if (wd === 1) return dateStr;    // 已是周一
    // 周日→+1 天到周一；其余（周二~周六）→ 前移到本周周一
    const delta = wd === 0 ? 1 : 1 - wd;
    d.setDate(d.getDate() + delta);
    const p = n => (n < 10 ? '0' : '') + n;
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

// 从课表页底部自带的周次表读取真实开学日期与总周次。
// 该周次表与课程格子同属这一个页面请求（是第二个 id=kbtable），不必再请求教学周历页。
function parseSemesterFromTable(doc) {
    let startDate = null;
    let totalWeeks = null;
    for (const table of doc.querySelectorAll('table')) {
        for (const row of table.querySelectorAll('tr')) {
            const blocks = row.textContent.match(/第\s*\d+\s*周\s*\d{4}-\d{2}-\d{2}/g);
            if (!blocks) continue;
            for (const b of blocks) {
                const m = /第\s*(\d+)\s*周\s*(\d{4})-(\d{2})-(\d{2})/.exec(b);
                if (!m) continue;
                const w = parseInt(m[1], 10);
                if (w > 0 && (totalWeeks === null || w > totalWeeks)) totalWeeks = w;
                if (w === 1 && !startDate) startDate = m[2] + '-' + m[3] + '-' + m[4];
            }
        }
    }
    if (startDate) startDate = toWeekMonday(startDate);
    return { startDate, totalWeeks };
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

// 页面当前选中的学期 id，仅用于开学日期兜底估算。
// 优先读 select.value：用户在前端切换后 DOM property 会变，
// 而 HTML attribute `selected` 仍停留在服务端渲染时的默认值。
function currentSemesterId(doc) {
    const select = doc.getElementById('xnxq01id');
    if (!select) return null;
    if (select.value) return select.value;
    const opt = select.querySelector('option[selected]') || select.querySelector('option');
    return opt ? opt.getAttribute('value') : null;
}

// 由 xnxq01id（如 2026-2027-1）估算开学日：1=当年 9 月首个周一，2=次年 2 月首个周一。
// 仅在课表页周次表读不到时作为弹框默认值兜底，优先读页面真实值。
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

/** 周次表读不到开学日期时的兜底：估算一个默认值让用户确认或修改 */
async function promptSemesterStartDate(semId) {
    const input = await window.shiguangBridgePromise.showPrompt(
        "开学日期",
        "未能从课表页读到开学日期，请手动输入(YYYY-MM-DD)：",
        guessSemesterStartDate(semId) || "",
        "validateDateInput");
    return (input != null && input !== "null" && /^\d{4}-\d{2}-\d{2}$/.test(input)) ? input : null;
}

/** 落库：课表配置 + 作息 + 课程 */
async function saveImportResult(courses, semesterStartDate, totalWeeks) {
    await window.shiguangBridgePromise.saveCourseConfig(JSON.stringify({
        semesterStartDate: semesterStartDate,
        semesterTotalWeeks: totalWeeks,
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
}

async function runImportFlow() {
    // App 每次点「执行导入」都会把整个脚本重新注入一遍，
    // 若上一轮还停在 showAlert 等待确认，并发跑两轮会导致第二次没反应
    if (window.__csuImportRunning) {
        window.shiguangBridge.showToast("请先在弹窗上确认或取消");
        return;
    }
    window.__csuImportRunning = true;

    try {
        // 页面已有课表就直接用（含课表的「我的桌面」页也可）；
        // 都没有且还在教务域内，才发同源请求兜底
        const onPage = pageHasSchedule();
        if (!onPage && !needFetchFallback()) {
            window.shiguangBridge.showToast("请先登录并进入课表页");
            return;
        }

        const confirmed = await window.shiguangBridgePromise.showAlert(
            "导入前确认",
            onPage
                ? "将导入当前页面上显示的课表。\n\n"
                  + "请先确认这就是你要导入的课表；想换学期，请先在课表页左上角切换「学年学期」。\n\n现在继续？"
                : "将读取教务系统的课表。\n\n现在继续？",
            "开始导入");
        if (!confirmed) return;

        window.shiguangBridge.showToast("正在读取课表…");

        // 优先用当前页面：用户切过的学期只存在于页面里，
        // 自己发请求只会拿回服务端的默认学期
        let doc = onPage ? document : null;
        if (!doc) {
            try {
                const resp = await fetch(location.origin + KB_PATH, {
                    method: "GET",
                    credentials: "include"
                });
                doc = parseDoc(await resp.text());
            } catch (err) {
                window.shiguangBridge.showToast("请求失败：" + ((err && err.message) ? err.message : err));
                return;
            }
            if (!findCourseTable(doc)) {
                window.shiguangBridge.showToast("没读到课表，请确认已登录");
                return;
            }
        }

        const courses = parseSchedule(doc);
        if (courses.length === 0) {
            window.shiguangBridge.showToast("当前页没有课程，请刷新重试");
            return;
        }

        // 开学日期与总周次读课表页自带的周次表，读不到才让用户手填
        const sem = parseSemesterFromTable(doc);
        let semesterStartDate = sem.startDate;
        if (!semesterStartDate) {
            semesterStartDate = await promptSemesterStartDate(currentSemesterId(doc));
            if (!semesterStartDate) {
                window.shiguangBridge.showToast("已取消：未填写开学日期");
                return;
            }
        }

        await saveImportResult(courses, semesterStartDate, sem.totalWeeks || 20);

        window.shiguangBridge.showToast("成功导入 " + courses.length + " 门课程");
        window.shiguangBridge.notifyTaskCompletion();
    } catch (err) {
        window.shiguangBridge.showToast("错误: " + (err && err.message ? err.message : err));
    } finally {
        window.__csuImportRunning = false;
    }
}

// Node 下把要供测试的函数交给外层；浏览器里没有 module，忽略即可
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        parseSchedule, parseDoc, parseWeeks, parseSections, parseKbContent,
        mergeCourses, currentSemesterId, parseSemesterFromTable,
        guessSemesterStartDate, cleanTeacher
    };
}

// 供 showPrompt 按字符串名回调的校验函数，IIFE 内需显式挂到 window
if (typeof window !== 'undefined') {
    window.validateDateInput = validateDateInput;
    window.runImportFlow = runImportFlow;   // 挂出口供离线测试直接驱动流程
}

// 入口：WebView 中桥接就绪即执行
if (typeof window !== 'undefined' && window.shiguangBridgePromise) {
    runImportFlow();
}

})();
