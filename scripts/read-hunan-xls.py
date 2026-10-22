"""Read the displayed retail/litre prices without recalculating workbook formulas."""
import datetime
import decimal
import json
import re
import sys


def extract(book, date):
    day = datetime.date.fromisoformat(date)
    if book.nsheets != 1:
        raise ValueError("湖南价格表工作表数量变化")
    sheet = book.sheet_by_index(0)
    if sheet.nrows > 100 or sheet.ncols != 6:
        raise ValueError("湖南价格表列数或范围变化")
    compact = lambda value: re.sub(r"\s+", "", str(value))
    rows = [[compact(value) for value in sheet.row_values(i)] for i in range(sheet.nrows)]
    expected = ["品名型号", "品质比率", "零售最高价（元/吨）", "零售最高价（元/升）",
                "对零售企业批发最高价（元/吨）", "对民营批发企业供应最高价（元/吨）"]
    if sum(row == expected for row in rows) != 1:
        raise ValueError("湖南零售元/升列标题变化")
    text = "".join("".join(row) for row in rows)
    if "湖南省成品油销售价格表" not in text or (
        f"此表价格为全省统一价，从{day.year}年{day.month}月{day.day}日24时起执行" not in text
    ):
        raise ValueError("湖南表内地域或生效时间不符")
    prices = {}
    for grade, label in [("92", "92号汽油（VIB）"), ("95", "95号汽油（VIB）"), ("diesel", "0号车用柴油（VI)")]:
        matches = [i for i, row in enumerate(rows) if row[0] == label]
        if len(matches) != 1:
            raise ValueError(f"湖南 {grade} 价格行缺失或重复")
        row = matches[0]
        cell = sheet.cell(row, 3)
        fmt = book.format_map[book.xf_list[cell.xf_index].format_key].format_str
        # The official XLS stores extra precision but displays two decimals.
        if cell.ctype != 2 or fmt not in ("0.00", "0.00_ ") or not 1 <= cell.value <= 30:
            raise ValueError(f"湖南 {grade} 数值类型或显示精度异常")
        prices[grade] = float(decimal.Decimal(str(cell.value)).quantize(decimal.Decimal("0.01"), rounding=decimal.ROUND_HALF_UP))
    return prices


if __name__ == "__main__":
    import xlrd
    try:
        book = xlrd.open_workbook(sys.argv[1], formatting_info=True)
        print(json.dumps(extract(book, sys.argv[2])))
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
