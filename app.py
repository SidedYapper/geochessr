import os
import random
import threading
import time
from datetime import datetime, timedelta
import uuid
from flask import (
    Flask,
    render_template,
    send_from_directory,
    request,
    jsonify,
    redirect,
    url_for,
    session,
)
from flask_session import Session
import redis
from geo_server.buiid_eco_json import get_eco_openings
from geo_server.sqlite_wrapper import SQLiteWrapper
from geo_server.manage_runs import create_run_and_add_to_database, RunSettings
from geo_server.constants import metadata_fields as SOURCE_METADATA_FIELDS
import dotenv
import secrets


def create_app() -> Flask:
    base_dir = os.path.abspath(os.path.dirname(__file__))
    dotenv.load_dotenv()
    app = Flask(
        __name__,
        template_folder=os.path.join(base_dir, "templates"),
    )
    # In dev mode, generate a new secret key each restart to invalidate all sessions
    # In production, use a persistent secret key from env var
    if os.getenv("FLASK_ENV") == "production":
        assert (
            os.getenv("APP_SECRET_KEY") is not None
        ), "APP_SECRET_KEY is not set. Cannot run in production mode."
        app.secret_key = os.getenv("APP_SECRET_KEY")
    else:

        app.secret_key = secrets.token_hex(32)

    styles_dir = os.path.join(base_dir, "styles")
    scripts_dir = os.path.join(base_dir, "scripts")
    assets_dir = os.path.join(base_dir, "assets")

    # -------------------- Session backend selection --------------------
    if os.getenv("FLASK_ENV") == "production":
        # Use Redis-backed server-side sessions in production
        redis_password = os.getenv("REDIS_PASSWORD")
        app.config["SESSION_TYPE"] = "redis"
        app.config["SESSION_REDIS"] = redis.Redis(
            host="localhost", port=6379, db=0, password=redis_password
        )
        app.config["SESSION_USE_SIGNER"] = True  # Sign session IDs
        app.config["SESSION_PERMANENT"] = True
        Session(app)
    else:
        # Dev: keep Flask default client-side signed cookie sessions; no Redis
        app.config.setdefault("SESSION_TYPE", "null")

    # -------------------- Session tracking for purge --------------------
    app.config.setdefault("SESSION_INDEX", {})  # sid -> last_access_ts (epoch seconds)
    app.config.setdefault("REVOKED_SIDS", set())

    def _get_or_set_sid():
        sid = session.get("sid")
        if not sid:
            sid = uuid.uuid4().hex
            session["sid"] = sid
        return sid

    @app.before_request
    def _track_session_last_access():
        try:
            sid = _get_or_set_sid()
            # If this sid was revoked by the background task, clear it now
            revoked = app.config.get("REVOKED_SIDS", set())
            if sid in revoked:
                try:
                    revoked.remove(sid)
                except Exception:
                    pass
                session.clear()
                # Assign a fresh sid after clearing
                session["sid"] = uuid.uuid4().hex
                sid = session["sid"]
            # Update last access time
            app.config["SESSION_INDEX"][sid] = time.time()
        except Exception:
            # Do not block requests on tracking errors
            pass

    def purge_old_sessions(max_age_seconds: int = 3600):
        now = time.time()
        index = app.config.get("SESSION_INDEX", {})
        to_revoke = []
        for sid, last_ts in list(index.items()):
            try:
                if (now - float(last_ts)) > max_age_seconds:
                    to_revoke.append(sid)
            except Exception:
                # If corrupted timestamp, revoke
                to_revoke.append(sid)
        if to_revoke:
            revoked = app.config.get("REVOKED_SIDS", set())
            for sid in to_revoke:
                revoked.add(sid)
                # Also remove from index so it doesn't grow unbounded
                try:
                    del index[sid]
                except Exception:
                    pass
            app.config["REVOKED_SIDS"] = revoked
            app.config["SESSION_INDEX"] = index

    def _redirect_to_daily_run():
        # Otherwise redirect to the daily run
        db_path = os.path.join(base_dir, "database", "geo_chess.db")
        wrapper = SQLiteWrapper(db_path)
        daily = wrapper.get_daily_run()
        try:
            wrapper.conn.close()
        except Exception:
            pass
        if daily is None:
            return "Daily run not configured", 500
        return redirect(url_for("run_page", run_id=daily.identifier))

    @app.route("/")
    def index():
        # If session has an unfinished run, continue that
        try:
            runs_state = session.get("runs") or {}
            active_run_id = session.get("active_run_id")
            if active_run_id and active_run_id in runs_state:
                db_path = os.path.join(base_dir, "database", "geo_chess.db")
                wrapper = SQLiteWrapper(db_path)
                run = wrapper.get_run(active_run_id)
                try:
                    wrapper.conn.close()
                except Exception:
                    pass
                if run and run.puzzle_ids:
                    st = runs_state[active_run_id]
                    cur_idx = int(st.get("current_index", 0))
                    cur_idx = max(0, min(len(run.puzzle_ids) - 1, cur_idx))
                    return redirect(
                        url_for("run_page", run_id=active_run_id, index=cur_idx)
                    )
        except Exception:
            pass
        return _redirect_to_daily_run()

    @app.route("/daily")
    def daily():
        return _redirect_to_daily_run()

    @app.route("/about")
    def about_page():
        return render_template("about.html")

    # -------------------- Daily background task --------------------
    def _seconds_until_next_midnight() -> float:
        now_dt = datetime.now()
        tomorrow = now_dt.date() + timedelta(days=1)
        midnight = datetime.combine(tomorrow, datetime.min.time())
        delta = (midnight - now_dt).total_seconds()
        # Safety: never negative
        return max(1.0, float(delta))

    def _run_daily_job():
        # Run forever as a daemon
        while True:
            try:
                # Sleep until next midnight
                sleep_s = _seconds_until_next_midnight()
                time.sleep(sleep_s)
                # Execute inside app context
                with app.app_context():
                    # Create the new daily run
                    db_path = os.path.join(base_dir, "database", "geo_chess.db")
                    wrapper = SQLiteWrapper(db_path)
                    try:
                        from geo_server.manage_runs import create_daily_run

                        create_daily_run(
                            wrapper,
                            grab_new_tournaments=True,
                            source=random.choice(["lichess", "world_champion"]),
                        )
                    finally:
                        try:
                            wrapper.conn.close()
                        except Exception:
                            pass
                    # Purge sessions not accessed in the last hour
                    purge_old_sessions(max_age_seconds=3600)
            except Exception:
                # If anything goes wrong, wait a minute and retry scheduling
                time.sleep(60)

    def _start_daily_thread_if_needed():
        # Avoid duplicate threads in reloader/production multi-workers
        if app.config.get("DAILY_THREAD_STARTED"):
            return
        # In debug with reloader, only start in the main subprocess
        if app.debug:
            if os.environ.get("WERKZEUG_RUN_MAIN") != "true":
                return

        if os.getenv("NO_DAILY_RUNNER") == "true":
            return
        t = threading.Thread(target=_run_daily_job, name="daily-runner", daemon=True)
        t.start()
        app.config["DAILY_THREAD_STARTED"] = True

    def _build_game_meta(geo):
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
            return {
                "result": result_map.get(res_key, ""),
                "whiteElo": round_elo(cg.whiteElo) if cg else None,
                "blackElo": round_elo(cg.blackElo) if cg else None,
                "timeControl": (cg.timeControl if cg else "") or "",
                "eco": (cg.eco if cg else "Unknown"),
                "opening_name": (
                    get_eco_openings().get(cg.eco, "Unknown") if cg else "Unknown"
                ),
                "moveNum": (
                    int(geo.move_num)
                    if getattr(geo, "move_num", None) is not None
                    else None
                ),
                "whitePlayer": (cg.whitePlayer if cg else None),
                "blackPlayer": (cg.blackPlayer if cg else None),
                "year": (cg.year if cg else None),
            }
        except Exception:
            return None

    def _mask_game_meta(
        game_meta: dict | None,
        run_id: str | None,
        puzzle_index: int | None,
        black_info_rate: float | None,
    ) -> dict | None:
        if not game_meta:
            return game_meta
        try:
            bir = float(black_info_rate or 0.0)
        except Exception:
            bir = 0.0
        if bir <= 0:
            return game_meta
        # Deterministic pseudo-random using SHA256 of (run_id|index|field)
        import hashlib

        def masked(field_name: str, value):
            try:
                key = f"{run_id}|{puzzle_index}|{field_name}".encode("utf-8")
                h = hashlib.sha256(key).digest()
                # Use first 4 bytes to get a float in [0,1)
                import struct

                rnd = struct.unpack("!I", h[:4])[0] / 2**32
                if rnd < bir:
                    return "*****"
                return value
            except Exception:
                return value

        masked_meta = dict(game_meta)
        masked_meta["result"] = masked("result", game_meta.get("result"))
        masked_meta["whiteElo"] = masked("whiteElo", game_meta.get("whiteElo"))
        masked_meta["blackElo"] = masked("blackElo", game_meta.get("blackElo"))
        masked_meta["timeControl"] = masked("timeControl", game_meta.get("timeControl"))
        masked_meta["moveNum"] = masked("moveNum", game_meta.get("moveNum"))
        masked_meta["whitePlayer"] = masked("whitePlayer", game_meta.get("whitePlayer"))
        masked_meta["blackPlayer"] = masked("blackPlayer", game_meta.get("blackPlayer"))
        masked_meta["year"] = masked("year", game_meta.get("year"))
        masked_meta["opening_name"] = masked(
            "opening_name", game_meta.get("opening_name")
        )
        return masked_meta

    def _subfen_last_move_cells(geo):
        cells = []
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
                        cells.append({"r": sr - by, "c": sc - bx})
                if dst is not None:
                    dr, dc = dst
                    if by <= dr < by + h and bx <= dc < bx + w:
                        cells.append({"r": dr - by, "c": dc - bx})
        except Exception:
            pass
        return cells

    @app.route("/run/<run_id>")
    def run_page(run_id: str):
        db_path = os.path.join(base_dir, "database", "geo_chess.db")
        wrapper = SQLiteWrapper(db_path)
        run = wrapper.get_run(run_id)
        if run is None or not run.puzzle_ids:
            try:
                wrapper.conn.close()
            except Exception:
                pass
            return "Run not found", 404
        # Session state: initialize or use stored index when present
        runs_state = session.get("runs") or {}
        st = runs_state.get(run.identifier) or {
            "current_index": 0,
            "submissions": [None]
            * len(
                run.puzzle_ids
            ),  # Each entry: None or {"x": int, "y": int, "correct": bool}
        }
        try:
            req_idx = int(request.args.get("index", "-1"))
        except Exception:
            req_idx = -1
        if req_idx >= 0:
            st["current_index"] = max(0, min(len(run.puzzle_ids) - 1, req_idx))
        index = int(st.get("current_index", 0))
        # Persist session state
        runs_state[run.identifier] = st
        session["runs"] = runs_state
        session["active_run_id"] = run.identifier
        geo = wrapper.get_geo_chess(run.puzzle_ids[index])
        try:
            wrapper.conn.close()
        except Exception:
            pass
        if geo is None:
            return "Puzzle not found", 404
        initial_subfen = geo.subfen
        geochess_id = geo.id
        try:
            top_left_light = ((int(geo.posx) + int(geo.posy)) % 2) == 0
        except Exception:
            top_left_light = None
        game_meta = _build_game_meta(geo)
        # Apply deterministic masking based on run settings
        try:
            masked_meta = _mask_game_meta(
                game_meta,
                run.identifier,
                index,
                run.black_info_rate,
            )
        except Exception:
            raise
            masked_meta = game_meta
        last_move_cells = _subfen_last_move_cells(geo)
        # Check if already submitted
        submissions = st.get("submissions") or []
        prior_sub = None
        if 0 <= index < len(submissions):
            prior_sub = submissions[index]
        # Pass all submissions if this is the last puzzle (for run summary)
        all_subs = submissions if index == len(run.puzzle_ids) - 1 else []
        return render_template(
            "index.html",
            initial_subfen=initial_subfen,
            geochess_id=geochess_id,
            last_move_cells=last_move_cells,
            top_left_light=top_left_light,
            game_meta=masked_meta,
            run_id=run.identifier,
            run_index=index,
            run_len=len(run.puzzle_ids),
            is_daily=run.is_daily,
            prior_submission=prior_sub,
            all_submissions=all_subs,
            metadata_fields=run.metadata_fields,
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
        # Update session submission state for active run (if any)
        try:
            runs_state = session.get("runs") or {}
            active_run_id = session.get("active_run_id")
            submissions = []
            if active_run_id and active_run_id in runs_state:
                st = runs_state[active_run_id]
                idx = int(st.get("current_index", 0))
                submissions = st.get("submissions") or []
                if 0 <= idx < len(submissions):
                    submissions[idx] = {"x": x, "y": y, "correct": bool(correct)}
                    st["submissions"] = submissions
                    runs_state[active_run_id] = st
                    session["runs"] = runs_state
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
                "pgn": (geo.chess_game.pgn if geo and geo.chess_game else None),
                # In feedback, do not apply masking – send full metadata
                "gameMeta": _build_game_meta(geo),
                # Full submissions array for run summary on the client
                "allSubmissions": submissions,
            }
        )

    @app.route("/api/next/<run_id>", methods=["GET"])
    def api_next(run_id: str):
        db_path = os.path.join(base_dir, "database", "geo_chess.db")
        wrapper = SQLiteWrapper(db_path)
        run = wrapper.get_run(run_id)
        if run is None or not run.puzzle_ids:
            try:
                wrapper.conn.close()
            except Exception:
                pass
            return jsonify({"ok": False, "error": "Run not found"}), 404
        # Use and advance session-tracked index
        runs_state = session.get("runs") or {}
        st = runs_state.get(run.identifier) or {
            "current_index": 0,
            "submissions": [None] * len(run.puzzle_ids),
        }
        cur_index = int(st.get("current_index", 0))
        next_index = cur_index + 1
        if next_index >= len(run.puzzle_ids):
            try:
                wrapper.conn.close()
            except Exception:
                pass
            return jsonify({"ok": False, "error": "No more puzzles"}), 404
        geo = wrapper.get_geo_chess(run.puzzle_ids[next_index])
        is_last = next_index == len(run.puzzle_ids) - 1
        try:
            wrapper.conn.close()
        except Exception:
            pass
        if geo is None:
            return jsonify({"ok": False, "error": "Puzzle not found"}), 404

        initial_subfen = geo.subfen
        geochess_id = geo.id
        last_move_cells = _subfen_last_move_cells(geo)
        try:
            top_left_light = ((int(geo.posx) + int(geo.posy)) % 2) == 0
        except Exception:
            top_left_light = None
        game_meta = _build_game_meta(geo)
        # Update session index
        st["current_index"] = next_index
        runs_state[run.identifier] = st
        session["runs"] = runs_state
        session["active_run_id"] = run.identifier
        try:
            masked_meta = _mask_game_meta(
                game_meta,
                run.identifier,
                next_index,
                run.black_info_rate,
            )
        except Exception:
            masked_meta = game_meta
        return jsonify(
            {
                "ok": True,
                "initial_subfen": initial_subfen,
                "geochess_id": geochess_id,
                "last_move_cells": last_move_cells,
                "top_left_light": top_left_light,
                "game_meta": masked_meta,
                "index": next_index,
                "len": len(run.puzzle_ids),
                "is_last": is_last,
                "is_daily": run.is_daily,
            }
        )

    @app.route("/api/create_run", methods=["POST"])
    def api_create_run():
        try:
            data = request.get_json(force=True, silent=False)
        except Exception:
            return jsonify({"ok": False, "error": "Invalid payload"}), 400

        # Map difficulty from slider (0..3) to percentages and black_info_rate
        difficulty = int(data.get("difficulty", 1))
        if difficulty == 0:
            min_dp, max_dp, bir, min_score = 0.0, 0.3, 0.0, 6.0
        elif difficulty == 1:
            min_dp, max_dp, bir, min_score = 0.2, 0.6, 0.2, 6.0
        elif difficulty == 2:
            min_dp, max_dp, bir, min_score = 0.4, 0.8, 0.5, 5.0
        else:
            min_dp, max_dp, bir, min_score = 0.6, 1.0, 0.8, 5.0

        n_puzzles = int(data.get("n_puzzles", 10))
        min_move = int(data.get("min_move", 5))
        max_move = int(data.get("max_move", 20))
        source = (data.get("source") or "lichess").strip()
        if source not in ("lichess", "world_champion"):
            source = "lichess"

        # Derive metadata_fields from selected source
        try:
            source_fields = SOURCE_METADATA_FIELDS.get(source, [])
        except Exception:
            source_fields = []

        settings = RunSettings(
            min_difficulty_percentage=min_dp,
            max_difficulty_percentage=max_dp,
            min_score=min_score,
            n_puzzles=n_puzzles,
            max_played=None,
            early_timestamp=None,
            late_timestamp=None,
            min_move_num=min_move,
            max_move_num=max_move,
            black_info_rate=bir,
            source=source,
            metadata_fields=source_fields,
        )

        db_path = os.path.join(base_dir, "database", "geo_chess.db")
        wrapper = SQLiteWrapper(db_path)
        try:
            run = create_run_and_add_to_database(wrapper, settings, False)
        except Exception as e:
            try:
                wrapper.conn.close()
            except Exception:
                pass
            return jsonify({"ok": False, "error": str(e)}), 500
        try:
            wrapper.conn.close()
        except Exception:
            pass
        return jsonify({"ok": True, "run_id": run.identifier})

    # Ensure the daily thread is started when the app is created
    _start_daily_thread_if_needed()
    return app


if __name__ == "__main__":
    app = create_app()
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", "5000")), debug=True)
