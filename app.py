import os
from flask import Flask, render_template, send_from_directory, request, jsonify
from geo_server.sqlite_wrapper import SQLiteWrapper


def create_app() -> Flask:
    base_dir = os.path.abspath(os.path.dirname(__file__))

    app = Flask(
        __name__,
        template_folder=os.path.join(base_dir, "templates"),
    )

    styles_dir = os.path.join(base_dir, "styles")
    scripts_dir = os.path.join(base_dir, "scripts")
    assets_dir = os.path.join(base_dir, "assets")

    @app.route("/")
    def index():
        db_path = os.path.join(base_dir, "database", "geo_chess.db")
        initial_subfen = None
        geochess_id = None
        last_move_cells = []
        top_left_light = None
        game_meta = None
        wrapper = SQLiteWrapper(db_path)
        geo = wrapper.get_random_geo_chess()
        # Close connection explicitly to avoid lingering connections per request
        try:
            wrapper.conn.close()
        except Exception:
            pass
        if geo is not None and getattr(geo, "subfen", None):
            initial_subfen = geo.subfen
            geochess_id = geo.id
            try:
                top_left_light = ((int(geo.posx) + int(geo.posy)) % 2) == 0
            except Exception:
                top_left_light = None
            # Build compact meta info for the game
            try:

                def round_elo(val):
                    try:
                        return int(round(int(val) / 100.0) * 100)
                    except Exception:
                        return None

                result_map = {1: "1-0", 0: "0-1", 0.5: "1/2-1/2"}
                cg = geo.chess_game
                res_key = None
                try:
                    # ChessGame.result is stored as float-like
                    rv = float(cg.result) if cg is not None else None
                    if rv is not None:
                        if abs(rv - 1.0) < 1e-9:
                            res_key = 1
                        elif abs(rv - 0.0) < 1e-9:
                            res_key = 0
                        else:
                            res_key = 0.5
                except Exception:
                    pass
                game_meta = {
                    "result": result_map.get(res_key, ""),
                    "whiteElo": round_elo(cg.whiteElo) if cg else None,
                    "blackElo": round_elo(cg.blackElo) if cg else None,
                    "timeControl": (cg.timeControl if cg else "") or "",
                    "moveNum": (
                        int(geo.move_num)
                        if getattr(geo, "move_num", None) is not None
                        else None
                    ),
                }
            except Exception:
                game_meta = None
            # Compute last move cells within subfen bounds
            try:
                lm = (geo.last_move or "").strip()
                if len(lm) == 4:

                    def sq_to_rc(sq: str):
                        files = "abcdefgh"
                        file_c = sq[0].lower()
                        rank_c = sq[1]
                        if file_c not in files or not rank_c.isdigit():
                            return None
                        col = files.index(file_c)
                        rank = int(rank_c)
                        if rank < 1 or rank > 8:
                            return None
                        row = 8 - rank  # 0 is top (rank 8)
                        return row, col

                    src = sq_to_rc(lm[0:2])
                    dst = sq_to_rc(lm[2:4])
                    bx, by = int(geo.posx), int(geo.posy)
                    w, h = int(geo.dimx), int(geo.dimy)
                    if src is not None:
                        sr, sc = src
                        if by <= sr < by + h and bx <= sc < bx + w:
                            last_move_cells.append({"r": sr - by, "c": sc - bx})
                    if dst is not None:
                        dr, dc = dst
                        if by <= dr < by + h and bx <= dc < bx + w:
                            last_move_cells.append({"r": dr - by, "c": dc - bx})
            except Exception:
                pass

        return render_template(
            "index.html",
            initial_subfen=initial_subfen,
            geochess_id=geochess_id,
            last_move_cells=last_move_cells,
            top_left_light=top_left_light,
            game_meta=game_meta,
        )

    @app.route("/styles/<path:filename>")
    def styles(filename: str):
        return send_from_directory(styles_dir, filename)

    @app.route("/scripts/<path:filename>")
    def scripts(filename: str):
        return send_from_directory(scripts_dir, filename)

    @app.route("/favicon.ico")
    def favicon():
        return send_from_directory(assets_dir, "favicon.ico")

    @app.route("/assets/<path:filename>")
    def assets(filename: str):
        return send_from_directory(assets_dir, filename)

    @app.route("/api/check_position", methods=["POST"])
    def api_check_position():
        try:
            data = request.get_json(force=True, silent=False)
            rec_id = int(data.get("id"))
            x = int(data.get("x"))
            y = int(data.get("y"))
        except Exception:
            return jsonify({"ok": False, "error": "Invalid request"}), 400

        db_path = os.path.join(base_dir, "database", "geo_chess.db")
        wrapper = SQLiteWrapper(db_path)
        geo = wrapper.get_geo_chess(rec_id)
        try:
            wrapper.conn.close()
        except Exception:
            pass
        if geo is None:
            return jsonify({"ok": False, "error": "Not found"}), 404

        posx = int(geo.posx)
        posy = int(geo.posy)
        correct = x == posx and y == posy
        # Build game link info
        try:
            move_num = int(geo.move_num)
            white_to_move = bool(geo.white_to_move)
            half_move_num = (move_num - 1) * 2 + (0 if white_to_move else 1)
        except Exception:
            half_move_num = None
        game_id = geo.chess_game.gameId if geo.chess_game else None
        game_url = (
            f"https://lichess.org/{game_id}#{half_move_num}"
            if (game_id and half_move_num is not None)
            else None
        )
        # Last move absolute cells on 8x8 board
        last_move_cells = []
        try:
            lm = (geo.last_move or "").strip()
            if len(lm) == 4:

                def sq_to_rc(sq: str):
                    files = "abcdefgh"
                    file_c = sq[0].lower()
                    rank_c = sq[1]
                    if file_c not in files or not rank_c.isdigit():
                        return None
                    col = files.index(file_c)
                    rank = int(rank_c)
                    if rank < 1 or rank > 8:
                        return None
                    row = 8 - rank
                    return row, col

                src = sq_to_rc(lm[0:2])
                dst = sq_to_rc(lm[2:4])
                if src is not None:
                    sr, sc = src
                    last_move_cells.append({"r": sr, "c": sc})
                if dst is not None:
                    dr, dc = dst
                    last_move_cells.append({"r": dr, "c": dc})
        except Exception:
            pass
        return jsonify(
            {
                "ok": True,
                "correct": bool(correct),
                "answer": {"x": posx, "y": posy},
                "fullFen": geo.fen,
                "gameId": game_id,
                "halfMoveNum": half_move_num,
                "gameUrl": game_url,
                "lastMoveCells": last_move_cells,
            }
        )

    @app.route("/api/next", methods=["GET"])
    def api_next():
        db_path = os.path.join(base_dir, "database", "geo_chess.db")
        wrapper = SQLiteWrapper(db_path)
        geo = wrapper.get_random_geo_chess()
        try:
            wrapper.conn.close()
        except Exception:
            pass
        if geo is None:
            return jsonify({"ok": False, "error": "No data"}), 404

        # Prepare payload similar to index route
        initial_subfen = geo.subfen
        geochess_id = geo.id

        # Subfen-relative last move cells
        last_move_cells = []
        try:
            lm = (geo.last_move or "").strip()
            if len(lm) == 4:

                def sq_to_rc(sq: str):
                    files = "abcdefgh"
                    file_c = sq[0].lower()
                    rank_c = sq[1]
                    if file_c not in files or not rank_c.isdigit():
                        return None
                    col = files.index(file_c)
                    rank = int(rank_c)
                    if rank < 1 or rank > 8:
                        return None
                    row = 8 - rank
                    return row, col

                src = sq_to_rc(lm[0:2])
                dst = sq_to_rc(lm[2:4])
                bx, by = int(geo.posx), int(geo.posy)
                w, h = int(geo.dimx), int(geo.dimy)
                if src is not None:
                    sr, sc = src
                    if by <= sr < by + h and bx <= sc < bx + w:
                        last_move_cells.append({"r": sr - by, "c": sc - bx})
                if dst is not None:
                    dr, dc = dst
                    if by <= dr < by + h and bx <= dc < bx + w:
                        last_move_cells.append({"r": dr - by, "c": dc - bx})
        except Exception:
            pass

        # Top-left parity for subfen
        try:
            top_left_light = ((int(geo.posx) + int(geo.posy)) % 2) == 0
        except Exception:
            top_left_light = None

        # Game meta
        game_meta = None
        try:

            def round_elo(val):
                try:
                    return int(round(int(val) / 100.0) * 100)
                except Exception:
                    return None

            result_map = {1: "1-0", 0: "0-1", 0.5: "1/2-1/2"}
            cg = geo.chess_game
            res_key = None
            try:
                rv = float(cg.result) if cg is not None else None
                if rv is not None:
                    if abs(rv - 1.0) < 1e-9:
                        res_key = 1
                    elif abs(rv - 0.0) < 1e-9:
                        res_key = 0
                    else:
                        res_key = 0.5
            except Exception:
                pass
            game_meta = {
                "result": result_map.get(res_key, ""),
                "whiteElo": round_elo(cg.whiteElo) if cg else None,
                "blackElo": round_elo(cg.blackElo) if cg else None,
                "timeControl": (cg.timeControl if cg else "") or "",
                "moveNum": (
                    int(geo.move_num)
                    if getattr(geo, "move_num", None) is not None
                    else None
                ),
            }
        except Exception:
            game_meta = None

        return jsonify(
            {
                "ok": True,
                "initial_subfen": initial_subfen,
                "geochess_id": geochess_id,
                "last_move_cells": last_move_cells,
                "top_left_light": top_left_light,
                "game_meta": game_meta,
            }
        )

    return app


if __name__ == "__main__":
    app = create_app()
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", "5000")), debug=True)
