class ApplicationController < ActionController::Base
  def current_user_id
    id = cookies.signed[:widget_user]
    return id if id && User.exists?(id: id)

    user = User.create!
    cookies.signed[:widget_user] = { value: user.id, httponly: true, same_site: :lax }
    user.id
  end

  def viewer_id
    cookies.signed[:widget_user]
  end
end
