/**
 * api/search.js — Vercel + Netlify 双平台通用
 *
 * 部署:
 *   - Vercel:  直接推到 GitHub,根目录有 api/ 文件夹自动识别 /api/*
 *   - Netlify: 配 netlify.toml 里 functions = "api",或放到 netlify/functions/
 *   - 本地测试: node -e "const h = require('./api/search.js'); h({query:{q:'ubuntu'}},{json:console.log,status:(c)=>console.log('status',c)}).then(r=>console.log('done'))"
 *
 * 请求:
 *   GET /api/search?q=关键词&safe=1
 *
 * 返回:
 *   { success, query, count, time, perSourceCount, results }
 */

// ==================== NSFW 黑名单 ====================
const NSFW_KEYWORDS = [
    '色情', '黄色', '成人', 'av', 'a片', '毛片', '三级', '无码', '有码',
    '中出', '口交', '后庭', '自慰', 'sm', '捆绑', '调教', 'hentai',
    'xxx', 'porn', 'porno', 'nsfw', '18+', 'adult', 'erotic', 'camgirl',
    'manyvids', 'chaturbate', 'stripchat', 'brazzers', 'realitykings',
    'phub', 'pornhub', 'xnxx', 'xhamster', 'spankbang', 'redtube',
    'jav', 'fc2', 'uncensored', 'censored', 'creampie', 'blowjob',
    'anal', 'dildo', 'vibrator', 'bondage', 'dungeon', 'mistress',
    'cumshot', 'bukkake', 'gangbang', 'orgy', 'threesome', 'swinger',
    'pedo', 'child', 'underage', 'lolita', 'loli', 'shota',
    'sex', 'nude', 'naked', 'sensual', 'provocative',
    'amateur', 'homemade', 'private', 'leaked'
];
const NSFW_REGEX = new RegExp(NSFW_KEYWORDS.join('|'), 'i');

function isNSFW(text) {
    if (!text) return false;
    return NSFW_REGEX.test(text);
}

// ==================== 数据源 ====================
const SOURCES = [
    {
        id: 'bitsearch',
        name: 'Bitsearch',
        enabled: true,
        weight: 1.2,
        pages: 3,
        perPage: 100,
        timeout: 4000,
        format: 'json',
        buildUrl: (q, limit, page) =>
            `https://bitsearch.eu/api/v1/search?q=${encodeURIComponent(q)}&limit=${limit}&page=${page}&verified=0`,
        parse: (raw) => {
            if (!raw || !raw.success || !Array.isArray(raw.results)) return [];
            return raw.results.map(r => ({
                name: r.title,
                sizeBytes: r.size || 0,
                size: formatBytes(r.size || 0),
                date: r.updatedAt ? new Date(r.updatedAt).toISOString().slice(0, 10) : '',
                seeds: r.seeders || 0,
                leechs: r.leechers || 0,
                verified: !!r.verified,
                source: 'Bitsearch',
                category: guessCategory(r.title),
                magnet: r.infohash
                    ? `magnet:?xt=urn:btih:${r.infohash}&dn=${encodeURIComponent(r.title)}`
                    : null
            })).filter(r => r.magnet);
        }
    },
    {
        id: 'tpb',
        name: 'ThePirateBay',
        enabled: true,
        weight: 1.0,
        pages: 1,
        perPage: 100,
        timeout: 4000,
        format: 'json',
        buildUrl: (q) => `https://apibay.org/q.php?q=${encodeURIComponent(q)}`,
        parse: (raw) => {
            if (!Array.isArray(raw)) return [];
            return raw.map(r => ({
                name: r.name,
                sizeBytes: parseInt(r.size, 10) || 0,
                size: formatBytes(parseInt(r.size, 10) || 0),
                date: r.added ? new Date(parseInt(r.added, 10) * 1000).toISOString().slice(0, 10) : '',
                seeds: parseInt(r.seeders, 10) || 0,
                leechs: parseInt(r.leechers, 10) || 0,
                verified: r.status === 'vip' || r.status === 'trusted',
                source: 'ThePirateBay',
                category: guessCategory(r.name),
                magnet: r.info_hash
                    ? `magnet:?xt=urn:btih:${r.info_hash}&dn=${encodeURIComponent(r.name)}`
                    : null
            })).filter(r => r.magnet);
        }
    },
    {
        id: 'yts',
        name: 'YTS',
        enabled: true,
        weight: 0.9,
        pages: 1,
        perPage: 50,
        timeout: 4000,
        format: 'json',
        buildUrl: (q, limit) =>
            `https://yts.mx/api/v2/list_movies.json?query_term=${encodeURIComponent(q)}&limit=${limit}`,
        parse: (raw) => {
            if (!raw || raw.status !== 'ok' || !raw.data || !Array.isArray(raw.data.movies)) return [];
            const out = [];
            for (const m of raw.data.movies) {
                for (const t of (m.torrents || [])) {
                    out.push({
                        name: `${m.title} (${m.year || ''}) ${t.quality || ''} ${t.type || ''}`.trim(),
                        sizeBytes: t.size_bytes || 0,
                        size: formatBytes(t.size_bytes || 0),
                        date: m.date_uploaded ? m.date_uploaded.slice(0, 10) : '',
                        seeds: t.seeds || 0,
                        leechs: t.peers || 0,
                        verified: false,
                        source: 'YTS',
                        category: '电影',
                        magnet: t.hash
                            ? `magnet:?xt=urn:btih:${t.hash}&dn=${encodeURIComponent(m.title)}`
                            : null
                    });
                }
            }
            return out.filter(r => r.magnet);
        }
    },
    {
        id: 'nyaa',
        name: 'Nyaa',
        enabled: true,
        weight: 0.8,
        pages: 1,
        perPage: 75,
        timeout: 4000,
        format: 'text',
        buildUrl: (q) => `https://nyaa.si/?page=rss&q=${encodeURIComponent(q)}&c=0_0&f=0`,
        parse: (text) => {
            if (typeof text !== 'string') return [];
            const items = text.match(/<item>[\s\S]*?<\/item>/g) || [];
            return items.map(it => {
                const title = decodeEntities((it.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '');
                const infoHash = (it.match(/nyaa:infoHash[^>]*>([^<]+)</) || [])[1] || '';
                const seeders = parseInt((it.match(/nyaa:seeders[^>]*>([^<]+)</) || [])[1] || '0', 10);
                const leechers = parseInt((it.match(/nyaa:leechers[^>]*>([^<]+)</) || [])[1] || '0', 10);
                const sizeBytes = parseInt((it.match(/nyaa:size[^>]*>([^<]+)</) || [])[1] || '0', 10);
                const date = (it.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || '';
                const category = /<nyaa:category>([^<]*)</.test(it) ? decodeEntities((it.match(/<nyaa:category>([^<]*)</) || [])[1]) : '动漫';
                return {
                    name: title,
                    sizeBytes,
                    size: formatBytes(sizeBytes),
                    date: date ? new Date(date).toISOString().slice(0, 10) : '',
                    seeds: seeders,
                    leechs: leechers,
                    verified: /nyaa:trusted[^>]*>Yes</.test(it),
                    source: 'Nyaa',
                    category: category || '动漫',
                    magnet: infoHash
                        ? `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(title)}`
                        : null
                };
            }).filter(r => r.magnet);
        }
    },
    {
        id: 'solidtorrents',
        name: 'SolidTorrents',
        enabled: true,
        weight: 0.95,
        pages: 1,
        perPage: 60,
        timeout: 4000,
        format: 'json',
        buildUrl: (q, limit) =>
            `https://solidtorrents.to/api/v1/search?q=${encodeURIComponent(q)}&page=1&size=${limit}&sort=seeders`,
        parse: (raw) => {
            const list = (raw && (raw.results || raw.hits)) || [];
            if (!Array.isArray(list)) return [];
            return list.map(r => {
                const title = r.title || r.name || '';
                const hash = r.infohash || r.info_hash || '';
                const magnet = r.magnet || (hash ? `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(title)}` : '');
                const sizeBytes = typeof r.size === 'number' ? r.size : parseInt(r.size, 10) || 0;
                const date = String(r.addedDate || r.added || r.date || '').slice(0, 10);
                return {
                    name: title,
                    sizeBytes,
                    size: formatBytes(sizeBytes),
                    date,
                    seeds: parseInt(r.seeders, 10) || 0,
                    leechs: parseInt(r.leechers, 10) || 0,
                    verified: false,
                    source: 'SolidTorrents',
                    category: r.category || guessCategory(title),
                    magnet
                };
            }).filter(r => r.magnet);
        }
    },
    {
        id: 'torrentgalaxy',
        name: 'TorrentGalaxy',
        enabled: true,
        weight: 0.7,
        pages: 1,
        perPage: 50,
        timeout: 4000,
        format: 'text',
        buildUrl: (q) => `https://torrentgalaxy.to/torrents.php?search=${encodeURIComponent(q)}&sort=seeders&order=desc`,
        parse: (html) => {
            if (typeof html !== 'string') return [];
            const seen = new Set();
            const out = [];
            const re = /magnet:\?xt=urn:btih:([a-fA-F0-9]{32,40})([^"'\s<>]*)/g;
            let m;
            while ((m = re.exec(html)) !== null) {
                const hash = m[1].toLowerCase();
                if (seen.has(hash)) continue;
                seen.add(hash);
                const dn = (m[2].match(/[?&]dn=([^&"'\s<>]+)/i) || [])[1] || '';
                const title = dn ? decodeEntities(decodeURIComponent(dn)) : hash;
                out.push({
                    name: title,
                    sizeBytes: 0,
                    size: '未知',
                    date: '',
                    seeds: 0,
                    leechs: 0,
                    verified: false,
                    source: 'TorrentGalaxy',
                    category: guessCategory(title),
                    magnet: `magnet:?xt=urn:btih:${hash}${dn ? `&dn=${dn}` : ''}`
                });
            }
            return out;
        }
    }
];

// ==================== 工具函数 ====================
function formatBytes(bytes) {
    if (!bytes || bytes < 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    let i = 0, val = bytes;
    while (val >= 1024 && i < units.length - 1) { val /= 1024; i++; }
    return `${val.toFixed(val >= 100 ? 0 : val >= 10 ? 1 : 2)} ${units[i]}`;
}

function decodeEntities(str) {
    if (!str) return '';
    return str
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;|&apos;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(parseInt(code, 10)));
}

function guessCategory(title) {
    const lower = (title || '').toLowerCase();
    if (/\.(mp4|mkv|avi|mov|wmv|flv|ts|webm|264|265|hevc|iso)/.test(lower)) {
        if (/4k|uhd|hdr|remux|bluray|blu-ray|1080p|720p/.test(lower)) return '电影/视频';
        return '视频';
    }
    if (/\.(mp3|flac|wav|aac|ogg|m4a|ape)/.test(lower)) return '音乐';
    if (/\.(zip|rar|7z|tar|gz|arj)/.test(lower)) return '压缩包';
    if (/\.(exe|msi|dmg|apk|pkg)/.test(lower)) return '软件';
    if (/\.(pdf|epub|mobi|txt|doc|docx|azw3)/.test(lower)) return '书籍';
    if (/\.(jpg|jpeg|png|gif|bmp|webp|psd)/.test(lower)) return '图片';
    if (/游戏|game|steam|switch|ps5|xbox|epic/.test(lower)) return '游戏';
    if (/动漫|anime|ova|oad/.test(lower)) return '动漫';
    if (/电视剧|tv|series|season|s\d+e\d+/.test(lower)) return '电视剧';
    return '其他';
}

// ==================== 匹配算法 ====================
// 三种模式:exact(精确) fuzzy(模糊) smart(智能,默认)
// 返回 0 = 不匹配, >0 = 匹配分数(越高越相关)

function normalize(s) {
    if (!s) return '';
    return s.toLowerCase()
        .replace(/\s+/g, ' ')           // 多空格归一成单空格
        .replace(/[，。、；：！？．]/g, ',') // 中文标点归一
        .replace(/[,\.!\?;:()\[\]{}]/g, ' ')
        .trim();
}

// 中文分词:按单字切 + 常见双字词表
const COMMON_DIGRAMS = new Set([
    '流浪', '地球', '三体', '狂飙', '伪装', '进击', '海贼', '火影', '死神',
    '咒术', '鬼灭', '间谍', '龙珠', '数码', '高达', '银河', '星际', '太空',
    '电影', '蓝光', '原盘', '高清', '超清', '无损', '字幕', '国语', '英语',
    '电影', '电视剧', '动漫', '番剧', '综艺', '纪录片', '纪录片', 'OST',
    'Ubuntu', 'Windows', 'MacOS', 'Android', 'iOS', 'Linux', 'Docker',
    'Python', 'JavaScript', 'Java', 'C++', 'Rust', 'Go语言'
]);

function segmentQuery(q) {
    // 同时尝试:完整词 + 单字 + 双字滑动窗口
    const result = new Set();
    result.add(q); // 完整匹配优先
    // 英文按空格分词
    const enWords = q.split(/[\s\-_]+/).filter(w => w.length >= 2);
    enWords.forEach(w => result.add(w));
    // 中文按双字切
    for (let i = 0; i < q.length - 1; i++) {
        const bigram = q.substring(i, i + 2);
        if (/\p{Script=Han}/u.test(bigram[0]) || /\p{Script=Han}/u.test(bigram[1])) {
            result.add(bigram);
        }
    }
    // 完整词 + 拆字(用于模糊匹配)
    return { tokens: [...result].filter(t => t.length >= 1), enWords };
}

/**
 * 计算 name 和 query 的匹配分数
 * mode: 'exact' | 'fuzzy' | 'smart'(默认)
 * 返回 { score, match: true/false, details: {...} }
 */
function scoreMatch(name, query, mode = 'smart') {
    if (!name || !query) return { score: 0, match: false };
    const n = normalize(name);
    const q = normalize(query);
    if (!n || !q) return { score: 0, match: false };

    let score = 0;
    let matched = false;
    const details = {};

    // 1) 完整子串精确命中 — 权重最高
    if (n.includes(q)) {
        score += 1000;
        matched = true;
        details.exactSub = true;
        // 开头命中更高
        if (n.startsWith(q)) score += 200;
    }

    // 2) 拆词 / 拆字命中数
    const { tokens, enWords } = segmentQuery(q);
    let tokenHits = 0;
    const hitTokens = [];
    tokens.forEach(t => {
        if (t.length >= 2 && n.includes(t)) {
            tokenHits++;
            hitTokens.push(t);
            score += t.length === 2 ? 30 : 50; // 双字 30,更长 50
        }
    });

    // 3) 单字覆盖率(主要对中文模糊有用)
    const qChars = Array.from(new Set(q.split('').filter(c => c.trim())));
    const charHits = qChars.filter(c => n.includes(c)).length;
    const charCoverage = qChars.length > 0 ? charHits / qChars.length : 0;

    details.charCoverage = charCoverage;
    details.tokenHits = tokenHits;

    // 4) 邻近加分 — 命中的 token 在 name 里彼此距离近
    if (hitTokens.length >= 2) {
        const positions = hitTokens.map(t => n.indexOf(t)).sort((a, b) => a - b);
        let nearbyCount = 0;
        for (let i = 1; i < positions.length; i++) {
            if (positions[i] - positions[i-1] < q.length * 1.5) nearbyCount++;
        }
        if (nearbyCount > 0) {
            score += nearbyCount * 15;
            details.nearbyBonus = nearbyCount;
        }
    }

    // 5) 模式判定
    if (mode === 'exact') {
        // 精确:必须完整子串匹配
        matched = n.includes(q);
        score = matched ? score + 500 : 0;
    } else if (mode === 'fuzzy') {
        // 模糊:至少 60% 单字覆盖 或 至少 1 个 token hit(英文 2+ 字符算)
        if (enWords.length > 0) {
            // 英文为主:至少 1 个完整英文 token 命中
            matched = tokenHits >= 1 || charCoverage >= 0.6;
        } else {
            matched = charCoverage >= 0.6 || tokenHits >= Math.max(1, Math.floor(q.length / 2));
        }
        if (matched) score += 100;
    } else {
        // smart:宽松多策略
        if (n.includes(q)) {
            matched = true;
        } else if (tokenHits >= Math.max(1, Math.floor(q.length / 3))) {
            matched = true;
            score += 50;
        } else if (charCoverage >= 0.5) {
            matched = true;
            score += 20;
        }
    }

    // 种子数参与最终评分,但匹配度优先
    return { score, match: matched, details };
}

// 兼容旧调用 — 现在内部用 scoreMatch 代替
function isRelevant(name, query) {
    return scoreMatch(name, query, 'smart').match;
}

// ==================== 请求 ====================
async function fetchOnePage(source, query, page) {
    const pageSize = source.perPage || 100;
    const timeoutMs = source.timeout || 4000;
    try {
        const url = source.buildUrl.length >= 3
            ? source.buildUrl(query, pageSize, page)
            : source.buildUrl(query, pageSize);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const res = await fetch(url, {
            headers: {
                'User-Agent': 'MagnetHunter/1.0 (+https://github.com/)',
                'Accept': source.format === 'text'
                    ? 'application/rss+xml, application/xml, */*'
                    : 'application/json, */*'
            },
            signal: controller.signal
        });
        clearTimeout(timer);
        if (!res.ok) return [];
        if (source.format === 'text') {
            const text = await res.text();
            return source.parse(text);
        }
        const json = await res.json();
        return source.parse(json);
    } catch {
        return [];
    }
}

async function fetchFromSource(source, query) {
    const pages = source.pages || 1;
    const pageResults = await Promise.all(
        Array.from({ length: pages }, (_, i) => fetchOnePage(source, query, i + 1))
    );
    let all = pageResults.flat();
    if (source.id !== 'bitsearch') {
        all = all.filter(r => isRelevant(r.name, query));
    }
    return all;
}

// ==================== 核心处理逻辑 ====================
async function doSearch(q, safe, match = 'smart') {
    const startTime = Date.now();
    const mode = ['exact', 'fuzzy', 'smart'].includes(match) ? match : 'smart';

    const enabledSources = SOURCES.filter(s => s.enabled);
    const resultsArrays = await Promise.all(enabledSources.map(s => fetchFromSource(s, q)));

    let all = resultsArrays.flat();

    if (safe) {
        all = all.filter(r => !isNSFW(r.name) && !isNSFW(r.category));
    }

    // 去重
    const seen = new Set();
    const deduped = all.filter(r => {
        const m = r.magnet && r.magnet.match(/btih:([a-fA-F0-9]+)/);
        const hash = m ? m[1].toLowerCase() : r.name;
        if (seen.has(hash)) return false;
        seen.add(hash);
        return true;
    });

    // 匹配模式过滤 + 打分 — 用 scoreMatch 同时拿到匹配判定和分数
    const matchedList = [];
    const unmatchedList = [];
    deduped.forEach(r => {
        const res = scoreMatch(r.name, q, mode);
        if (res.match) {
            matchedList.push({ record: r, matchScore: res.score });
        } else {
            unmatchedList.push({ record: r, matchScore: res.score });
        }
    });

    // 只返回匹配命中的(精确模式下 unmatchedList 是空的,模糊和智能也一样)
    // 但如果 matchedList 极少(≤5)且模式是 smart,降级到 fuzzy 再捞一次
    let finalPool = matchedList;
    if (mode === 'smart' && matchedList.length <= 5 && unmatchedList.length > 0) {
        console.log(`[智能匹配] 精确 + 分词命中仅 ${matchedList.length} 条,自动降级到模糊再捞...`);
        const fuzzyRescored = unmatchedList.map(({ record }) => {
            const res = scoreMatch(record.name, q, 'fuzzy');
            return { record, matchScore: res.score, fuzzy: res.match };
        }).filter(x => x.fuzzy);
        finalPool = [...matchedList, ...fuzzyRescored.map(x => ({ record: x.record, matchScore: x.matchScore }))];
    }

    // 最终排序:匹配分数优先 × 种子数 × verified × 源权重
    const scored = finalPool.map(({ record, matchScore }) => {
        const r = record;
        let seedScore = (r.seeds || 0);
        seedScore *= 1 + Math.min(seedScore / 5000, 3);
        if (r.verified) seedScore *= 1.1;
        const src = SOURCES.find(s => s.name === r.source);
        if (src) seedScore *= src.weight;
        // 匹配分数主导排序(×1000 确保比种子数的影响大)
        const _score = matchScore * 1000 + seedScore;
        return { ...r, _score };
    });

    scored.sort((a, b) => b._score - a._score);
    const final = scored.map(r => { delete r._score; return r; });

    const elapsed = Date.now() - startTime;

    const perSourceCount = {};
    final.forEach(r => { perSourceCount[r.source] = (perSourceCount[r.source] || 0) + 1; });

    return {
        success: true,
        query: q,
        mode,
        total: deduped.length,
        count: final.length,
        time: elapsed,
        sources: enabledSources.map(s => s.name),
        perSourceCount,
        results: final
    };
}

// ==================== Vercel 适配:handler(req, res) ====================
async function handleVercel(req, res) {
    let q = '';
    let safe = true;
    let match = 'smart';
    if (req.query && req.query.q) {
        q = String(req.query.q).trim();
        safe = req.query.safe !== '0';
        match = String(req.query.match || 'smart').trim();
    } else if (req.url) {
        try {
            const url = new URL(req.url, 'https://vercel.app');
            q = (url.searchParams.get('q') || '').trim();
            safe = url.searchParams.get('safe') !== '0';
            match = url.searchParams.get('match') || 'smart';
        } catch {}
    }

    if (!q) {
        res.status(400).json({ success: false, error: '缺少搜索关键词 q' });
        return;
    }

    const data = await doSearch(q, safe, match);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.status(200).json(data);
}

// ==================== Netlify 适配:handler(event, context) ====================
async function handleNetlify(event) {
    const params = event.queryStringParameters || {};
    const q = (params.q || '').trim();
    const safe = params.safe !== '0';
    const match = params.match || 'smart';

    if (!q) {
        return {
            statusCode: 400,
            headers: {
                'Content-Type': 'application/json; charset=utf-8',
                'Access-Control-Allow-Origin': '*'
            },
            body: JSON.stringify({ success: false, error: '缺少搜索关键词 q' })
        };
    }

    const data = await doSearch(q, safe, match);
    return {
        statusCode: 200,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type'
        },
        body: JSON.stringify(data)
    };
}

// ==================== 统一导出 ====================
// Netlify / AWS Lambda:   exports.handler(event, context)
// Vercel (Express):        module.exports = handler(req, res)
// 两边都要正确,否则会报 "handler is undefined or not exported"
function handler(arg1, arg2) {
    // Vercel Express 风格:第二个参数有 .json() 和 .status()
    if (arg2 && typeof arg2.json === 'function' && typeof arg2.status === 'function') {
        return handleVercel(arg1, arg2);
    }
    // Netlify Lambda 风格
    return handleNetlify(arg1 || {});
}

// 关键!Netlify 找 module.exports.handler,而不是 module.exports 本身
// 所以必须同时赋值到 exports.handler 和 module.exports.handler
exports.handler = handler;
module.exports = handler;
module.exports.handler = handler;
// 额外导出内部函数供本地 Express server.js 复用
module.exports.doSearch = doSearch;
