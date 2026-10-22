"""Read text tables only; scanned PDFs and ambiguous layouts fail closed."""
import datetime
import json
from pathlib import Path
import re
import sys
import zipfile
import xml.etree.ElementTree as ET


def require(condition, message):
    if not condition:
        raise ValueError(message)


def compact(value):
    return re.sub(r"\s+", "", value or "")


def price(value):
    require(isinstance(value, str) and re.fullmatch(r"\d{1,2}\.\d{2}", value), "每升价格精度或格式变化")
    number = float(value)
    require(1 <= number <= 30, "每升价格范围异常")
    return number


def date_label(day):
    d = datetime.date.fromisoformat(day)
    return f"{d.year}年{d.month}月{d.day}日"


def read_pdf(file):
    import pdfplumber
    require(Path(file).stat().st_size <= 1_000_000, "PDF 超过大小限制")
    with pdfplumber.open(file) as pdf:
        require(1 <= len(pdf.pages) <= 4, "PDF 页数异常")
        text = "".join(page.extract_text() or "" for page in pdf.pages)
        tables = [table for page in pdf.pages for table in page.extract_tables()]
    require(len(text) > 100 and len(tables) == 1, "PDF 缺少唯一的可读文字价表；不猜测扫描图片")
    return compact(text), [[compact(cell) if cell is not None else None for cell in row] for row in tables[0]]


def parse_jilin(text, rows, day):
    require("吉林省成品油最高零售价格表" in text and date_label(day) + "24时起执行" in text, "吉林 PDF 标题或生效日不符")
    require(rows[0] == ["品名", "品质比率", "每吨价格(元)", "密度值(kg/m3)", "每升最高零售价(元)"], "吉林 PDF 列单位发生变化")
    patterns = {"92": r"92[#＃]乙醇汽油", "95": r"95[#＃]乙醇汽油", "diesel": r"0[#＃]车用柴油[（(]标准品[）)]"}
    prices = {}
    for grade, pattern in patterns.items():
        matches = [row for row in rows[1:] if row[0] and re.fullmatch(pattern, row[0])]
        require(len(matches) == 1 and len(matches[0]) == 5, f"吉林 {grade} 油号不唯一或缺失")
        prices[grade] = price(matches[0][4])
    require(prices["95"] > prices["92"], "吉林汽油油号顺序异常")
    return {"jilin": prices}


YUNNAN_GROUPS = [
    ("yunnan-kunming", ["昆明"]), ("yunnan-zone2", ["曲靖", "楚雄", "玉溪"]),
    ("yunnan-zone3", ["昭通", "红河", "文山", "大理"]),
    ("yunnan-zone4", ["普洱", "保山", "丽江"]),
    ("yunnan-zone5", ["版纳", "德宏", "迪庆", "怒江", "临沧"])
]


def parse_yunnan(text, rows, day):
    require("云南省各地区汽、柴油最高零售价格表" in text and
            "执行日期:" + date_label(day) + "24时起" in text.replace("：", ":"), "云南 PDF 标题或生效日不符")
    require(len(rows) == 18 and rows[0] == ["地区", "调整后零售价(元/吨)", None, None, None,
                                           "调整后零售价(元/升)", None, None, None], "云南价表的吨价、升价分栏异常")
    expected = [None] + ["89#Ⅵ汽油", "92#Ⅵ汽油", "95#Ⅵ汽油", "0号国Ⅵ车用柴油"] * 2
    require(rows[1] == expected, "云南油号列顺序发生变化")
    result, offset = {}, 2
    for key, names in YUNNAN_GROUPS:
        group = rows[offset:offset + len(names)]
        require([row[0] for row in group] == names and all(len(row) == 9 for row in group), "云南价区归属或顺序发生变化")
        # Only the first row owns a merged price cell. Do not forward-fill an
        # arbitrary blank row: every following region and merge is explicit.
        require(all(all(cell is None for cell in row[1:]) for row in group[1:]), "云南合并单元格结构变化")
        require(all(re.fullmatch(r"\d{4,5}", value or "") for value in group[0][1:5]), "云南吨价列异常")
        result[key] = dict(zip(["92", "95", "diesel"], [price(group[0][i]) for i in [6, 7, 8]]))
        require(result[key]["95"] > result[key]["92"], "云南汽油油号顺序异常")
        offset += len(names)
    return result


def read_docx(file):
    require(Path(file).stat().st_size <= 1_000_000, "Word 附件超过大小限制")
    with zipfile.ZipFile(file) as archive:
        infos = archive.infolist()
        require(len(infos) <= 300 and sum(item.file_size for item in infos) <= 10_000_000, "Word 解压大小异常")
        matches = [item for item in infos if item.filename == "word/document.xml"]
        require(len(matches) == 1 and matches[0].file_size <= 3_000_000, "Word 正文缺失或重复")
        xml = archive.read(matches[0])
    require(b"<!DOCTYPE" not in xml and b"<!ENTITY" not in xml, "Word 正文不支持外部实体")
    root = ET.fromstring(xml)
    ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
    def text(element):
        return compact("".join(node.text or "" for node in element.findall(".//w:t", ns)))
    tables = root.findall(".//w:tbl", ns)
    require(len(tables) == 1, "Word 价格表不唯一")
    rows = [[text(cell) for cell in row.findall("w:tc", ns)] for row in tables[0].findall("w:tr", ns)]
    return text(root), rows


def parse_sichuan(text, rows, day):
    require("四川省汽、柴油最高批发零售价格表" in text and "（" + date_label(day) + "）" in text,
            "四川 Word 标题或日期不符")
    require("阿坝州所属汶川县、理县、茂县以及凉山州、攀枝花市行政区域为二价区" in text, "四川二价区行政范围发生变化")
    require(len(rows) == 9 and rows[0] == ["品名", "一价区", "二价区", "三价区"] and
            len(rows[2]) == 10 and all(rows[2][i] == "元/升" for i in [3, 6, 9]), "四川 Word 价区列或单位异常")
    require(rows[1] == ["", "最高批发价格", "最高零售价格", "最高批发价格", "最高零售价格", "最高批发价格", "最高零售价格"],
            "四川 Word 批发、零售表头发生变化")
    prices = {}
    for grade, pattern in {"92": r"92[﹟#＃]汽油", "95": r"95[﹟#＃]汽油", "diesel": r"0[﹟#＃]车用柴油"}.items():
        matches = [row for row in rows if row and re.match(pattern, row[0])]
        require(len(matches) == 1 and len(matches[0]) == 10, f"四川 {grade} 价格行异常")
        values = [price(matches[0][i]) for i in [3, 6, 9]]
        require(values[0] < values[1] < values[2], "四川价区顺序异常")
        prices[grade] = values[1]
    return {"sichuan-zone2": prices}


def main():
    group, file, day = sys.argv[1:]
    if group == "sichuan":
        result = parse_sichuan(*read_docx(file), day)
    elif group in ["jilin", "yunnan"]:
        result = {"jilin": parse_jilin, "yunnan": parse_yunnan}[group](*read_pdf(file), day)
    else:
        raise ValueError("不支持的附件类型")
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
