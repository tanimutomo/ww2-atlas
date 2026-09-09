// YAML の読み込みは必ずここを通す。
//
// js-yaml の既定スキーマは `1940-12-18` を JS の Date に変換してしまう。
// この vault のデータは日付を「文字列のまま」比較・ファイル名・ID に使うので、
// timestamp タグを持たない CORE_SCHEMA で読む（数値・真偽値・null は従来どおり効く）。

import { readFile } from 'node:fs/promises';
import yaml from 'js-yaml';

/** YAML 文字列をパースする（日付は文字列のまま） */
export const parseYaml = (text, filename) =>
  yaml.load(text, { schema: yaml.CORE_SCHEMA, filename });

/** YAML ファイルを読む（日付は文字列のまま） */
export const loadYaml = async (path) => parseYaml(await readFile(path, 'utf8'), path);
