#!/usr/bin/env python3
"""
完全导出 WRF wrfout 的所有 3D 风场（U/V/W 所有高度层）到 GeoJSON。
features 数 = time × levels × lat × lon
用法：
  python3 nc-to-geojson-3d-wind.py /path/to/wrfout -o out/wind_3d.geojson --force
"""
from pathlib import Path
import argparse, json, sys
import numpy as np
from netCDF4 import Dataset, num2date

CAND_LAT = ["XLAT","lat","latitude","LAT","XLAT_M","XLAT_C"]
CAND_LON = ["XLONG","lon","longitude","LON","XLONG_M","XLONG_C"]

def find_var(nc, candidates):
    names = list(nc.variables.keys())
    lname_map = {n.lower(): n for n in names}
    for c in candidates:
        if c.lower() in lname_map:
            return lname_map[c.lower()]
    return None

def compute_speed_dir(u, v):
    """计算风速和风向"""
    sp = np.sqrt(u*u + v*v)
    dir_deg = (np.degrees(np.arctan2(u, v)) + 360.0) % 360.0
    return sp, dir_deg

def get_height_levels(nc, dim_name):
    """从 ZNU 或 ZNW 获取高度层信息（相对高度比例）"""
    if dim_name == "bottom_top" and "ZNU" in nc.variables:
        return nc.variables["ZNU"][0, :]  # shape (49,)
    if dim_name == "bottom_top_stag" and "ZNW" in nc.variables:
        return nc.variables["ZNW"][0, :]  # shape (50,)
    return None

def safe_get_time_str(nc, idx):
    """从 Times 变量获取时间字符串"""
    try:
        if "Times" in nc.variables:
            times_var = nc.variables["Times"]
            time_bytes = times_var[idx, :]
            if isinstance(time_bytes[0], bytes):
                return "".join([t.decode() for t in time_bytes])
            else:
                return "".join([str(t) for t in time_bytes])
    except Exception:
        pass
    return None

def interpolate_u_to_mass_grid(u_stag):
    """
    将 U（west_east_stag 网格）插值到质点网格。
    输入: shape (ny, nx_stag)
    输出: shape (ny, nx)
    """
    ny, nx_stag = u_stag.shape
    u_mass = np.zeros((ny, nx_stag - 1))
    for i in range(ny):
        for j in range(nx_stag - 1):
            u_mass[i, j] = (u_stag[i, j] + u_stag[i, j + 1]) / 2.0
    return u_mass

def interpolate_v_to_mass_grid(v_stag):
    """
    将 V（south_north_stag 网格）插值到质点网格。
    输入: shape (ny_stag, nx)
    输出: shape (ny, nx)
    """
    ny_stag, nx = v_stag.shape
    v_mass = np.zeros((ny_stag - 1, nx))
    for i in range(ny_stag - 1):
        for j in range(nx):
            v_mass[i, j] = (v_stag[i, j] + v_stag[i + 1, j]) / 2.0
    return v_mass

def main():
    p = argparse.ArgumentParser(description="导出 WRF 3D 风场（全高度层 U/V/W）为 GeoJSON")
    p.add_argument("nc", help="输入 nc 文件")
    p.add_argument("-o", "--out", default="out/wind_3d.geojson", help="输出 GeoJSON 文件")
    p.add_argument("--force", action="store_true", help="必须加 --force 才会执行")
    p.add_argument("--max-features", type=int, default=None, help="仅导出前 N 个要素（用于测试）")
    p.add_argument("--use-w-only", action="store_true", help="仅导出 W（竖直风），不插值 U/V")
    args = p.parse_args()

    ncpath = Path(args.nc)
    if not ncpath.exists():
        print("错误：找不到文件", ncpath)
        sys.exit(1)
    if not args.force:
        print("危险操作：将导出全部 3D 风场格点（可能非常大）。请加 --force 确认。")
        sys.exit(1)

    outpath = Path(args.out)
    outpath.parent.mkdir(parents=True, exist_ok=True)

    nc = Dataset(str(ncpath), "r")

    # 检测坐标系
    lat_name = find_var(nc, CAND_LAT)
    lon_name = find_var(nc, CAND_LON)
    if not lat_name or not lon_name:
        print("未找到经纬度变量")
        nc.close()
        sys.exit(1)

    print(f"使用坐标: lat={lat_name}, lon={lon_name}")

    # 优先查找 3D 风场（U/V/W）
    if "U" in nc.variables and "V" in nc.variables and "W" in nc.variables:
        print("优先导出 3D 风场（U/V/W 所有高度层）")
        use_3d = True
    elif "U10" in nc.variables and "V10" in nc.variables:
        print("仅找到地表 U10/V10，导出地表风场")
        use_3d = False
    else:
        print("未找到 U/V 变量")
        nc.close()
        sys.exit(1)

    # 获取维度信息
    if use_3d:
        u_var = nc.variables["U"]  # (Time, bottom_top, south_north, west_east_stag)
        v_var = nc.variables["V"]  # (Time, bottom_top, south_north_stag, west_east)
        w_var = nc.variables["W"]  # (Time, bottom_top_stag, south_north, west_east)

        nt = nc.dimensions["Time"].size
        nl_u = nc.dimensions["bottom_top"].size
        nl_w = nc.dimensions["bottom_top_stag"].size
        ny = nc.dimensions["south_north"].size
        nx = nc.dimensions["west_east"].size

        print(f"维度检测：time={nt}, levels_u={nl_u}, levels_w={nl_w}, lat={ny}, lon={nx}")

        lat = nc.variables[lat_name][0, :, :]  # (57, 57) 质点网格
        lon = nc.variables[lon_name][0, :, :]  # (57, 57) 质点网格

        height_levels_u = get_height_levels(nc, "bottom_top")
        height_levels_w = get_height_levels(nc, "bottom_top_stag")

        with outpath.open("w", encoding="utf-8") as fo:
            fo.write('{"type":"FeatureCollection","features":[\n')
            first = True
            cnt = 0
            # 使用 U 层数作为主要导出对象
            total = nt * nl_u * ny * nx

            for ti in range(nt):
                time_str = safe_get_time_str(nc, ti)
                print(f"处理时间步 {ti+1}/{nt}，时间: {time_str}")

                for li in range(nl_u):
                    # 读取该层的 U、V、W
                    try:
                        u_layer_stag = np.array(u_var[ti, li, :, :])  # (ny, nx+1)
                        v_layer_stag = np.array(v_var[ti, li, :, :])  # (ny+1, nx)

                        # 插值到质点网格
                        u_layer = interpolate_u_to_mass_grid(u_layer_stag)  # (ny, nx)
                        v_layer = interpolate_v_to_mass_grid(v_layer_stag)  # (ny, nx)

                        # W 在 li 和 li+1 之间的中间高度，简化：取 li 或平均
                        if li < nl_w:
                            w_layer = np.array(w_var[ti, li, :, :])  # (ny, nx)
                        else:
                            w_layer = np.zeros((ny, nx))

                    except Exception as e:
                        print(f"读取风场层失败 (ti={ti}, li={li}): {e}")
                        continue

                    for yi in range(ny):
                        lon_row = lon[yi, :]
                        lat_row = lat[yi, :]
                        u_row = u_layer[yi, :]
                        v_row = v_layer[yi, :]
                        w_row = w_layer[yi, :]

                        for xi in range(nx):
                            lon_val = float(lon_row[xi])
                            lat_val = float(lat_row[xi])
                            u_val = float(u_row[xi]) if np.isfinite(u_row[xi]) else None
                            v_val = float(v_row[xi]) if np.isfinite(v_row[xi]) else None
                            w_val = float(w_row[xi]) if np.isfinite(w_row[xi]) else None

                            sp, dr = (None, None)
                            if u_val is not None and v_val is not None:
                                sp, dr = compute_speed_dir(u_val, v_val)
                                sp = float(sp)
                                dr = float(dr)

                            props = {
                                "time_index": int(ti),
                                "level_index": int(li),
                                "lat_idx": int(yi),
                                "lon_idx": int(xi),
                                "U": u_val,
                                "V": v_val,
                                "W": w_val,
                                "speed": sp,
                                "direction": dr,
                            }
                            if time_str:
                                props["time"] = time_str
                            if height_levels_u is not None and li < len(height_levels_u):
                                props["height_level"] = float(height_levels_u[li])

                            feat = json.dumps({
                                "type": "Feature",
                                "geometry": {"type": "Point", "coordinates": [lon_val, lat_val]},
                                "properties": props
                            }, ensure_ascii=False)

                            if not first:
                                fo.write(",\n")
                            fo.write(feat)
                            first = False
                            cnt += 1

                            if args.max_features and cnt >= args.max_features:
                                break
                        if args.max_features and cnt >= args.max_features:
                            break
                    if args.max_features and cnt >= args.max_features:
                        break

                    if cnt % 10000 == 0:
                        print(f"已写要素: {cnt} / 预计 {total}")

                if args.max_features and cnt >= args.max_features:
                    break

            fo.write("\n]}\n")

        nc.close()
        print(f"完成：已写 {cnt} 要素（3D 风场）到 {outpath}")

    else:
        # 使用 U10/V10 地表风
        print("使用地表 U10/V10 导出")

        lat = nc.variables[lat_name][0, :, :]
        lon = nc.variables[lon_name][0, :, :]
        u10 = nc.variables["U10"][0, :, :]
        v10 = nc.variables["V10"][0, :, :]

        ny, nx = lat.shape

        with outpath.open("w", encoding="utf-8") as fo:
            fo.write('{"type":"FeatureCollection","features":[\n')
            first = True
            cnt = 0

            time_str = safe_get_time_str(nc, 0)

            for yi in range(ny):
                lon_row = lon[yi, :]
                lat_row = lat[yi, :]
                u_row = u10[yi, :]
                v_row = v10[yi, :]

                for xi in range(nx):
                    lon_val = float(lon_row[xi])
                    lat_val = float(lat_row[xi])
                    u_val = float(u_row[xi]) if np.isfinite(u_row[xi]) else None
                    v_val = float(v_row[xi]) if np.isfinite(v_row[xi]) else None

                    sp, dr = (None, None)
                    if u_val is not None and v_val is not None:
                        sp, dr = compute_speed_dir(u_val, v_val)
                        sp = float(sp)
                        dr = float(dr)

                    props = {
                        "lat_idx": int(yi),
                        "lon_idx": int(xi),
                        "U10": u_val,
                        "V10": v_val,
                        "speed": sp,
                        "direction": dr,
                        "level": "surface",
                    }
                    if time_str:
                        props["time"] = time_str

                    feat = json.dumps({
                        "type": "Feature",
                        "geometry": {"type": "Point", "coordinates": [lon_val, lat_val]},
                        "properties": props
                    }, ensure_ascii=False)

                    if not first:
                        fo.write(",\n")
                    fo.write(feat)
                    first = False
                    cnt += 1

            fo.write("\n]}\n")

        nc.close()
        print(f"完成：已写 {cnt} 要素（地表风）到 {outpath}")

if __name__ == "__main__":
    main()


