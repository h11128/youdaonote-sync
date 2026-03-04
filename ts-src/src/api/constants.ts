/**
 * Youdao Note API: URL templates and request constants (headers, page size).
 */
export const ROOT_ID_URL =
  'https://note.youdao.com/yws/api/personal/file?method=getByPath&keyfrom=web&cstk={cstk}';
export const DIR_MES_URL =
  'https://note.youdao.com/yws/api/personal/file/{dir_id}?all=true&f=true&len={page_size}&sort=1' +
  '&isReverse=false&method=listPageByParentId&keyfrom=web&cstk={cstk}';
export const FILE_URL =
  'https://note.youdao.com/yws/api/personal/sync?method=download&_system=macos&_systemVersion=&' +
  '_screenWidth=1280&_screenHeight=800&_appName=ynote&_appuser=0123456789abcdeffedcba9876543210&' +
  '_vendor=official-website&_launch=16&_firstTime=&_deviceId=0123456789abcdef&_platform=web&' +
  '_cityCode=110000&_cityName=&sev=j1&keyfrom=web&cstk={cstk}';
export const PUSH_URL =
  'https://note.youdao.com/yws/api/personal/sync?method=push&_system=windows&_systemVersion=&' +
  '_screenWidth=1400&_screenHeight=900&_appName=ynote&_appuser=0123456789abcdeffedcba9876543210&' +
  '_vendor=official-website&_launch=1&_firstTime=&_deviceId=0123456789abcdef&_platform=web&' +
  '_cityCode=&_cityName=&_product=YNote-Web&_version=&sev=j1&sec=v1&keyfrom=web&cstk={cstk}';
export const DELETE_URL =
  'https://note.youdao.com/yws/api/personal/file/{file_id}?method=delete&keyfrom=web&cstk={cstk}';
export const LIST_RECENT_URL =
  'https://note.youdao.com/yws/api/personal/file?method=listRecent&keyfrom=web&cstk={cstk}';

export const DIR_PAGE_SIZE = 9999;

export function tpl(url: string, vars: Record<string, string>): string {
  let result = url;
  for (const [k, v] of Object.entries(vars)) {
    result = result.replaceAll(`{${k}}`, v);
  }
  return result;
}

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/100.0.4896.88 Safari/537.36';

export const BASE_HEADERS: Record<string, string> = {
  'User-Agent': USER_AGENT,
  Accept: '*/*',
  'Accept-Encoding': 'gzip, deflate',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'sec-ch-ua': '" Not A;Brand";v="99", "Chromium";v="100", "Google Chrome";v="100"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
};
