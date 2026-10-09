"""Register the feature blueprints before creating their /demo aliases."""


def register_blueprints(app):
    """Import routes after app.py has initialized their shared dependencies."""
    from routes.demographics import demographics_bp
    from routes.projects import projects_bp
    from routes.questions import questions_bp
    from routes.quotes import quotes_bp
    from routes.themes import themes_bp
    from routes.llm_setup import llm_setup_bp 
    from routes.transcript_history import transcript_history_bp

    app.register_blueprint(demographics_bp)
    app.register_blueprint(projects_bp)
    app.register_blueprint(questions_bp)
    app.register_blueprint(quotes_bp)
    app.register_blueprint(themes_bp)
    app.register_blueprint(llm_setup_bp)
    app.register_blueprint(transcript_history_bp)
