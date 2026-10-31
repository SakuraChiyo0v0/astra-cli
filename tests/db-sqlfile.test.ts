/**
 * SQL 文件切分：`db exec` / `db schema apply` 的地基。
 *
 * 切错不会报错，只会把一条语句切成两条去执行 —— 表建坏了才发现，所以这里钉死。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isReadonly, splitStatements, statementKind } from '../src/core/db/sqlfile.ts'

test('普通多条语句按分号切开', () => {
  const out = splitStatements('create table a(id int); insert into a values (1); select * from a;')
  assert.equal(out.length, 3)
  assert.equal(statementKind(out[0]!), 'create')
  assert.equal(statementKind(out[2]!), 'select')
})

test('字符串里的分号不能切', () => {
  const out = splitStatements("insert into t values ('a;b'); select 1;")
  assert.equal(out.length, 2)
  assert.match(out[0]!, /'a;b'/)
})

test("字符串里的 '' 转义", () => {
  const out = splitStatements("insert into t values ('it''s ok; really');")
  assert.equal(out.length, 1)
})

test('行注释和块注释里的分号要跳过，且注释不单独成句', () => {
  const sql = `
-- 建表；顺便说一句
create table a(id int); /* 中间;注释 */
-- 收尾
insert into a values (1);
`
  const out = splitStatements(sql)
  assert.equal(out.length, 2)
  assert.equal(statementKind(out[0]!), 'create')
  assert.equal(statementKind(out[1]!), 'insert')
})

test('PG 美元引用里的分号不切', () => {
  const sql = `create function f() returns void as $$
begin
  raise notice 'a;b';
end;
$$ language plpgsql;
select 1;`
  const out = splitStatements(sql)
  assert.equal(out.length, 2)
  assert.match(out[0]!, /language plpgsql/)
})

test('带标签的美元引用 $tag$ 也认', () => {
  const sql = `do $body$ begin perform 1; end $body$; select 2;`
  const out = splitStatements(sql)
  assert.equal(out.length, 2)
})

test('双引号标识符里的分号不切', () => {
  const out = splitStatements('select 1 as "a;b"; select 2;')
  assert.equal(out.length, 2)
})

test('只读判定：select/with/explain 算只读，create/insert 不算', () => {
  assert.equal(isReadonly('select 1'), true)
  assert.equal(isReadonly('/* x */ with a as (select 1) select * from a'), true)
  assert.equal(isReadonly('explain select 1'), true)
  assert.equal(isReadonly('create table t(id int)'), false)
  assert.equal(isReadonly('insert into t values (1)'), false)
  assert.equal(isReadonly('drop table t'), false)
})
