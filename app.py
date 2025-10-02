import os
from flask import Flask, render_template, send_from_directory


def create_app() -> Flask:
    base_dir = os.path.abspath(os.path.dirname(__file__))

    app = Flask(
        __name__,
        template_folder=os.path.join(base_dir, "templates"),
    )

    styles_dir = os.path.join(base_dir, "styles")
    scripts_dir = os.path.join(base_dir, "scripts")
    assets_cburnett_dir = os.path.join(base_dir, "assets", "cburnett")

    @app.route("/")
    def index():
        return render_template("index.html")

    @app.route("/styles/<path:filename>")
    def styles(filename: str):
        return send_from_directory(styles_dir, filename)

    @app.route("/scripts/<path:filename>")
    def scripts(filename: str):
        return send_from_directory(scripts_dir, filename)

    @app.route("/assets/cburnett/<path:filename>")
    def assets_cburnett(filename: str):
        return send_from_directory(assets_cburnett_dir, filename)

    return app


if __name__ == "__main__":
    app = create_app()
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", "5000")), debug=True)
