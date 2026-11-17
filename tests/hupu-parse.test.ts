/**
 * 虎扑解析层单测：只喂固定 HTML，不走网络。
 *
 * 覆盖三个容易反复出错的点：
 *  1. 列表页同一 tid 出现多次 → 去重；标题前的序号、过短标题要洗掉
 *  2. 正文主楼和 seo-dom 有两份副本 → 整段去重，工具栏不能被当成正文
 *  3. 板块从 <title> 的第二段取，取不到给 null 而不是猜
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { boardOf, parseList, parsePost, stripTags, tidOf } from '../src/hupu/api.ts'

const LIST_HTML = `
<html><body>
  <a href="/644006891.html"><span class="t-title">毁三观呀，浙江理工大学的学生</span></a>
  <a href="/644006891.html">毁三观呀，浙江理工大学的学生（侧栏重复）</a>
  <a href="/123.html">短</a>
  <a href="/644006892.html">3 房价下跌，怎么和自己和解</a>
  <a href="/topic-daily">热帖榜</a>
  <a href="/644006893.html">彦祖兄弟们，我这练了3年～够看吗</a>
</body></html>`

test('parseList：去重、洗序号、丢短标题、忽略非帖子链接', () => {
  const items = parseList(LIST_HTML)
  assert.deepEqual(
    items.map((i) => i.tid),
    ['644006891', '644006892', '644006893'],
  )
  assert.equal(items[0]!.title, '毁三观呀，浙江理工大学的学生')
  assert.equal(items[1]!.title, '房价下跌，怎么和自己和解')
  assert.equal(items[2]!.url, 'https://bbs.hupu.com/644006893.html')
})

const POST_HTML = `
<html><head>
  <title>聊找到白女以后的感受-步行街主干道-虎扑社区</title>
</head><body>
  <div class="post-user_post-user-comp-info-bottom-link__x">作者：</div>
  <div class="post-user-name">澳洲老哥</div>
  <div class="index_bbs-thread-comp__PC7_r bbs-thread-comp main-thread">
    <div class="thread-content-detail">
      <p>找了澳洲女朋友以后的一些感受，接触过国内女生和澳洲本地女生。</p>
      <div class="slate-image"><p><img src="https://i5.hoopchina.com.cn/a.jpg"></p></div>
      <p>她们普遍比较独立，恋爱里也更强调双方平等。</p>
    </div>
    <div class="seo-dom">
      <p>找了澳洲女朋友以后的一些感受，接触过国内女生和澳洲本地女生。</p>
    </div>
  </div>
  <div class="post-toolbar">推荐 (341)评论 (109)收藏分享QQ微信扫一扫分享举报只看楼主含AI生成内容</div>
  <div>这些回帖亮了</div>
  <div class="thread-comment">这种是要遭报应的</div>
</body></html>`

test('parsePost：标题/板块/正文去重，工具栏与回帖不进正文', () => {
  const post = parsePost(POST_HTML, '643975554')
  assert.equal(post.title, '聊找到白女以后的感受')
  assert.equal(post.board, '步行街主干道')
  assert.equal(post.views, 341)
  assert.equal(post.replies, 109)
  assert.ok(post.content.includes('找了澳洲女朋友以后的一些感受'))
  assert.ok(post.content.includes('她们普遍比较独立'))
  // 只出现一次（seo-dom 副本被去重）
  assert.equal(post.content.split('找了澳洲女朋友以后').length - 1, 1)
  // 工具栏与回帖内容不混进正文
  assert.ok(!post.content.includes('只看楼主'))
  assert.ok(!post.content.includes('含AI生成内容'))
  assert.ok(!post.content.includes('这种是要遭报应的'))
  assert.equal(post.images, 1)
  // 正文不能带标签残片（曾经从 class= 开始切，混进 'class="..."' 前缀）
  assert.ok(!post.content.includes('class='), 'content 里不应出现标签属性')
})

test('boardOf：三段标题取第二段，两段给 null', () => {
  assert.equal(boardOf('标题-步行街主干道-虎扑社区'), '步行街主干道')
  assert.equal(boardOf('只有标题'), null)
})

test('tidOf：链接与纯数字都认，其它返回 null', () => {
  assert.equal(tidOf('https://bbs.hupu.com/643975554.html'), '643975554')
  assert.equal(tidOf('643975554'), '643975554')
  assert.equal(tidOf('https://bbs.hupu.com/topic-daily'), null)
  assert.equal(tidOf('abc'), null)
})

test('stripTags：常用实体与 <br> 还原', () => {
  assert.equal(stripTags('a&amp;b<br>c'), 'a&b\nc')
})
